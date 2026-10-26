import type { RuntimeContext } from '../runtime-context.js'
import type { AppSession, PageSession, RouterState } from './bridge-router-types.js'

/**
 * The session's current active-page bridgeId per the same rule `getActiveBridgeId`
 * and `getActiveRenderWc` expose to consumers: prefer the explicit ACTIVE_PAGE
 * signal, else fall back to the root page (= appSessionId) — but only while
 * that page is still alive, since navigation can close the root and then the
 * fallback would name a page that no longer exists. Shared so `ensureRenderBound`
 * can recognize "this bind is for the active page" using the identical
 * definition of "active" the accessors use.
 */
export function resolveActiveBridgeId(ap: AppSession): string | null {
  if (ap.activeBridgeId) return ap.activeBridgeId
  return ap.pages.has(ap.appSessionId) ? ap.appSessionId : null
}

/** The session's live top-of-stack page, or undefined when it has none. */
export function activePageOf(state: RouterState, ap: AppSession): PageSession | undefined {
  const bridgeId = resolveActiveBridgeId(ap)
  return bridgeId ? state.pageSessions.get(bridgeId) : undefined
}

// Same-appId matches prefer the MOST RECENT spawn (Maps preserve insertion
// order): after a respawn/reopen the newest session is the live one — the
// first match could be a just-superseded session mid-teardown. The loop must
// scan every session (no early break) so the LAST inserted match wins.
export function findAppSessionByAppId(state: RouterState, appId: string): AppSession | undefined {
  let match: AppSession | undefined
  for (const ap of state.appSessions.values()) if (ap.appId === appId) match = ap
  return match
}

// No appId hint and no workspace session to disambiguate. Picking by appId is
// impossible, so fall back to the most-recent spawn — but ONLY when every live
// session belongs to the same app. Same-appId multiples are a respawn/reopen
// in progress where the newest is the live one (insertion order = spawn
// order). Multiple DISTINCT appIds mean a previous project is mid-teardown
// alongside the new one; any pick is a guess that can resolve the WRONG
// project's content (the screenshot/inspect-stale-app bug class), so prefer
// null over a wrong guess.
export function resolveFallbackAppSession(state: RouterState): AppSession | undefined {
  let last: AppSession | undefined
  const distinctAppIds = new Set<string>()
  for (const ap of state.appSessions.values()) {
    last = ap
    distinctAppIds.add(ap.appId)
  }
  return distinctAppIds.size <= 1 ? last : undefined
}

/**
 * Resolve the "current" app session: prefer an explicit appId, else the
 * workspace's active project, else the only / most-recently-created session.
 * Native-host can host multiple AppSessions, so this picks one deterministically
 * rather than assuming a single session.
 */
export function resolveCurrentApp(
  state: RouterState,
  ctx: RuntimeContext,
  appId?: string,
): AppSession | undefined {
  if (appId) {
    const match = findAppSessionByAppId(state, appId)
    if (match) return match
  }
  const appInfo = ctx.workspace?.getSession?.()?.appInfo as { appId?: string } | undefined
  const activeAppId = appInfo?.appId
  if (activeAppId) {
    const match = findAppSessionByAppId(state, activeAppId)
    if (match) return match
  }
  // During a project close the workspace nulls its session BEFORE the bridge app
  // session is torn down (disposeSession runs before disposeAll). Resolving here
  // would hand a consumer the closing project's dying guest, so refuse to guess
  // while a close is in flight.
  if (ctx.workspace?.isClosing?.()) return undefined
  return resolveFallbackAppSession(state)
}


export function clearLaunchTimer(ap: AppSession): void {
  if (ap.launchTimer === null) return
  clearTimeout(ap.launchTimer)
  ap.launchTimer = null
}

/**
 * Arm the `LAUNCH_TIMEOUT_MS` watchdog for a freshly spawned session. Fires
 * `'launch-failed'` (`code: 'timeout'`) exactly once, and only if the session
 * is both still registered (not disposed) and has not already reached
 * `'running'` — both settle paths clear the timer themselves, but a timer
 * queued just before either lands could still fire on the old macrotask queue.
 */
