import type { AppSession, PageSession, RouterState } from './bridge-router-types.js'
import { clearLaunchTimer } from './bridge-router-state.js'

// ── Dispose ─────────────────────────────────────────────────────────────────

export function disposePageSession(state: RouterState, ap: AppSession, page: PageSession): void {
  if (page.renderWc && !page.renderWc.isDestroyed()) {
    state.wcIdToBridgeId.delete(page.renderWc.id)
  }
  ap.pages.delete(page.bridgeId)
  state.pageSessions.delete(page.bridgeId)
  // A page is closed before the shell has re-rendered and reported its new top,
  // so these two would go on naming a page that no longer exists — and callers
  // read them meanwhile (panels resolving a target, automation reading the
  // stack). Clear them and let the shell's next ACTIVE_PAGE / PAGE_STACK fill
  // them in. `getActiveBridgeId`'s own root fallback is guarded on the root
  // page still being in `ap.pages`, which this delete has already settled.
  if (ap.activeBridgeId === page.bridgeId) {
    ap.activeBridgeId = null
  }
  if (ap.visibleBridgeId === page.bridgeId) {
    ap.visibleBridgeId = null
  }
  ap.pageStack = undefined
}

// Drain any pending API calls owned by this app session. One-shot calls
// normally self-clean on response/timeout, but persistent (`keep: true`)
// subscriptions (e.g. audioListen) live with their timer cleared until
// teardown — without this they would leak in pendingApiCalls forever.
export function drainPendingApiCallsForSession(state: RouterState, appSessionId: string): void {
  for (const [requestId, pending] of state.pendingApiCalls) {
    if (pending.appSessionId !== appSessionId) continue
    clearTimeout(pending.timer)
    state.pendingApiCalls.delete(requestId)
  }
}

// Closes every page's render guest and drops its wc/pageSessions bindings.
// Caller clears `ap.pages` itself right after — this only tears each page
// down, it doesn't touch the map.
export function closeSessionPages(state: RouterState, ap: AppSession): void {
  for (const page of ap.pages.values()) {
    if (page.renderWc && !page.renderWc.isDestroyed()) {
      state.wcIdToBridgeId.delete(page.renderWc.id)
      // The render-host <webview> guest is otherwise reclaimed only when its
      // host simulator WCV is destroyed, and that cascade is async. Close it
      // here so a project-close / respawn tears the guest down deterministically
      // rather than leaving the outgoing project's guest alive to be
      // screenshotted or re-resolved by the next project. Idempotent with the
      // cascade (guarded on isDestroyed).
      try {
        page.renderWc.close()
      } catch {
        /* guest already gone */
      }
    }
    state.pageSessions.delete(page.bridgeId)
  }
}

// Three-way release of the session's service-host window: pool release (soft
// reuse), pool reclaim of an externally-closed window, or a plain close for
// the unpooled path.
export async function releaseServiceWindow(
  state: RouterState,
  ap: AppSession,
  opts: { serviceAlreadyClosed?: boolean },
): Promise<void> {
  if (ap.poolEntryId !== null && state.pool && !opts.serviceAlreadyClosed) {
    // Soft reuse (see foundation.md): the pooled service-host webContents keeps
    // its wc.id but is about to run a NEW app session. Reset its Connection
    // BEFORE returning it to the pool — dispose this session's owned segment
    // (the serviceWc binding cleanup) and swap a fresh one — so an old in-flight
    // response can't bleed into the next session and the next spawn `acquire`s a
    // clean segment. The connection object stays alive (it's reused), so this is
    // reset (not close); a real destroy still closes it via its 'destroyed' hook.
    state.connections.reset(ap.serviceWc.id)
    // Return the window to the pool instead of closing it. Detach the boot
    // listener first (the 'closed' hook already came off with the listener-bag
    // dispose above) so a stale did-finish-load can't boot this disposed
    // session into the next spawn's recycled window.
    if (ap.onServiceBoot && !ap.serviceWindow.isDestroyed()) {
      ap.serviceWindow.webContents.removeListener('did-finish-load', ap.onServiceBoot)
    }
    await state.pool.release(ap.poolEntryId, ap.serviceWindow).catch(error => {
      console.warn('[bridge-router] pool release failed:', error)
    })
  } else if (ap.poolEntryId !== null && state.pool && opts.serviceAlreadyClosed) {
    // The pooled service window already closed/crashed externally (its 'closed'
    // fired → onServiceClosed → here). `release` is skipped on this path, and the
    // pool only auto-reclaims on render-process-gone — so without this the in-use
    // entry leaks in the pool forever, permanently shrinking capacity. Reclaim
    // the slot explicitly (the window is already gone; releaseDestroyed won't
    // touch it).
    state.pool.releaseDestroyed(ap.poolEntryId)
  } else if (!opts.serviceAlreadyClosed && !ap.serviceWindow.isDestroyed()) {
    ap.serviceWindow.close()
  }
}

export function unbindSessionFromSharedMaps(
  state: RouterState,
  ap: AppSession,
  appSessionId: string,
): void {
  // Value-checked unbind for the service wc: this delete runs after the
  // pool-release await above, so on the pool path the next spawn may have
  // already re-acquired the SAME window and rebound its wc id — only remove
  // an entry that still names THIS session.
  if (state.serviceWcIdToAppSessionId.get(ap.serviceWc.id) === appSessionId) {
    state.serviceWcIdToAppSessionId.delete(ap.serviceWc.id)
  }
  // The simulator wc's hosted set sheds only this session; sessions that are
  // still live on the shared wc (the soft-reload survivor) keep their
  // membership. The map entry goes away with the last session.
  const hosted = state.simulatorWcIdToAppSessionIds.get(ap.simulatorWc.id)
  if (hosted) {
    hosted.delete(appSessionId)
    if (hosted.size === 0) state.simulatorWcIdToAppSessionIds.delete(ap.simulatorWc.id)
  }
}

export async function disposeAppSession(
  state: RouterState,
  appSessionId: string,
  opts: { serviceAlreadyClosed?: boolean } = {},
): Promise<void> {
  const ap = state.appSessions.get(appSessionId)
  if (!ap) return
  state.appSessions.delete(appSessionId)
  // Prevent a leaked/stale watchdog: without this, a session disposed while
  // still 'launching' (e.g. project close mid-launch) would fire its timer
  // `LAUNCH_TIMEOUT_MS` later against an already-torn-down session.
  clearLaunchTimer(ap)
  // Remove this session's shutdown-fallback registry entry so the registry does
  // not accumulate one stale closure per respawn. Ordered AFTER the delete
  // above: dispose() runs the wrapped fn (disposeAppSession again), which
  // early-returns now that the session is gone — no recursion, no double-run.
  // (At whole-app shutdown the registry marks the entry released before calling
  // the fn, so this dispose() is a no-op then.)
  const registryHandle = ap.registryHandle
  ap.registryHandle = null
  void registryHandle?.dispose()
  state.appLifecycle.dispose(appSessionId)
  state.nativeWebSocket.disposeOwner(appSessionId)
  state.nativeRequest.disposeOwner(appSessionId)

  // Evict AppData bridges FIRST — eviction enumerates `ap.pages`, which the
  // page teardown below progressively empties (and finally clears).
  state.evictAppDataBridges(ap)

  drainPendingApiCallsForSession(state, appSessionId)

  closeSessionPages(state, ap)
  ap.pages.clear()

  // Detach every session-scoped hook on emitters that outlive this session —
  // the shared simulator WCV's 'destroyed' and the service window's 'closed' —
  // BEFORE the window is released/closed below: a pool-recycled window must
  // not re-trigger this session's teardown from a stale 'closed', and the
  // simulator wc must not accumulate one dead hook per soft reload until the
  // MaxListeners warning fires. Idempotent with teardown being triggered BY
  // one of these hooks (removing a fired once() is a no-op).
  ap.listenerBag.dispose()

  await releaseServiceWindow(state, ap, opts)

  unbindSessionFromSharedMaps(state, ap, appSessionId)

  // Only the local fallback server needs closing; the dev-server base is owned
  // by the workspace session, not this app session.
  if (ap.resourceServer) {
    await ap.resourceServer.close().catch(error => {
      console.warn('[bridge-router] resource server close failed:', error)
    })
  }
}

