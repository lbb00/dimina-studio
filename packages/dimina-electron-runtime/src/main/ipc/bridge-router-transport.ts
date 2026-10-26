import { webContents } from 'electron'
import type { WebContents } from 'electron'
import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type { MessageEnvelope } from '../../shared/bridge-channels.js'
import type { RuntimeContext } from '../runtime-context.js'
import type { AppSession, PageSession, RouterState } from './bridge-router-types.js'
import { disposeAppSession } from './bridge-router-dispose.js'
import { findAppSessionByAppId, resolveActiveBridgeId } from './bridge-router-state.js'

export function forwardToService(ap: AppSession, msg: MessageEnvelope): void {
  if (ap.serviceWc.isDestroyed()) return
  // Before the service host's TO_SERVICE listener exists, `send` would fire
  // into the void (Electron doesn't queue across a navigation/preload gap) —
  // queue instead, in arrival order, for `bootServiceHost` to flush once it
  // confirms the listener is live. See `AppSession.serviceHostReady`.
  if (!ap.serviceHostReady) {
    ap.pendingServiceMessages.push(msg)
    return
  }
  ap.serviceWc.send(C.TO_SERVICE, { msg })
}

export function forwardToRender(ap: AppSession, msg: MessageEnvelope, targetBridgeId?: string): void {
  const renderBridgeId = targetBridgeId || readBridgeId(msg)
  if (!renderBridgeId) {
    throw new Error(
      '[bridge-router] cannot route to render: missing bridgeId in body and no explicit target',
    )
  }
  const page = ap.pages.get(renderBridgeId)
  if (!page) return
  const renderWc = page.renderWc
  if (renderWc && !renderWc.isDestroyed()) {
    renderWc.send(C.TO_RENDER, { msg })
  }
}

export function ensureRenderBound(
  state: RouterState,
  sender: WebContents,
  bridgeId: string,
): PageSession | undefined {
  const page = state.pageSessions.get(bridgeId)
  if (!page) return undefined
  // A destroyed sender is never a valid owner, even when it's still the
  // recorded `renderWc` (e.g. a message queued before teardown lands after):
  // reject before any state mutation so a dead webContents can't re-arm
  // bookkeeping that its own destroy handler (below) is about to tear down.
  if (sender.isDestroyed()) return undefined
  if (page.renderWc !== sender) {
    // A superseded guest is never resurrected: it was replaced by a newer
    // bind below (renderWc is monotonic — the current owner only moves
    // forward), so a message it sends after losing ownership is discarded
    // rather than reclaiming `renderWc` or re-emitting `activePage` on its
    // behalf. Cleared once that webContents is actually destroyed (below).
    if (page.supersededRenderWcIds.has(sender.id)) return undefined
    if (page.renderWc && page.renderWc !== sender && !page.renderWc.isDestroyed()) {
      console.warn(
        `[bridge-router] page ${bridgeId} render webview swap (wc ${page.renderWc.id} → ${sender.id})`,
      )
      page.supersededRenderWcIds.add(page.renderWc.id)
      // The replaced guest loses both ownership and the reverse lookup in the
      // same step, so census-style bindings counts reflect the swap
      // immediately instead of waiting for the old guest's own destroy to fire.
      if (state.wcIdToBridgeId.get(page.renderWc.id) === bridgeId)
        state.wcIdToBridgeId.delete(page.renderWc.id)
    }
    page.renderWc = sender
    state.wcIdToBridgeId.set(sender.id, bridgeId)
    // Consolidate the render-guest bookkeeping teardown onto the connection
    // layer (see foundation.md): the render guest is its own webContents =
    // its own connection; own() ties this cleanup to its lifetime so it
    // fires on destroy, replacing the bespoke `once('destroyed')`. acquire() is
    // idempotent — re-binding the same sender re-uses its connection.
    state.connections.acquire(sender).own(() => {
      const p = state.pageSessions.get(bridgeId)
      // A current page guest disappearing is not a recoverable page-level
      // transition: unlike PAGE_CLOSE, its renderer can no longer deliver the
      // lifecycle/dispose messages that would release the service host and the
      // rest of this app session. Take the same single teardown path as every
      // other owner loss. A replaced guest is deliberately ignored here: it
      // no longer equals renderWc, and PAGE_CLOSE already removed its page.
      const currentOwnerLost = p?.renderWc === sender
      if (currentOwnerLost) {
        p.renderWc = null
        void disposeAppSession(state, p.appSessionId)
      }
      if (p) p.supersededRenderWcIds.delete(sender.id)
      if (state.wcIdToBridgeId.get(sender.id) === bridgeId) state.wcIdToBridgeId.delete(sender.id)
    })
    // The active page's guest binds AFTER `onActivePage` already fired (SPAWN/
    // PAGE_OPEN never know the guest webContents up front) — re-emit `activePage`
    // now so a subscriber that reads `getActiveRenderWc()` on that signal (e.g.
    // elements-forward priming a fresh DOM snapshot) doesn't permanently miss a
    // page's first activation. Only for the active page — and only while its
    // AppSession is still the one `findAppSessionByAppId` resolves to for this
    // appId: a same-appId respawn/reopen supersedes the old session (see
    // `findAppSessionByAppId`), and a bind landing on that stale session must
    // not surface as if it were the app's current active page. A background
    // page binding its guest is likewise not an activity a panel needs to
    // react to.
    const ap = state.appSessions.get(page.appSessionId)
    if (
      ap &&
      resolveActiveBridgeId(ap) === bridgeId &&
      findAppSessionByAppId(state, ap.appId) === ap
    ) {
      state.emitRenderEvent({
        kind: 'activePage',
        appId: ap.appId,
        bridgeId,
        pagePath: page.pagePath,
        query: page.query,
      })
    }
  }
  return page
}

export function pageFromMsg(
  state: RouterState,
  ap: AppSession,
  msg: MessageEnvelope,
): PageSession | undefined {
  const target = readBridgeId(msg)
  if (!target) return undefined
  const page = ap.pages.get(target)
  return page
}

export function appByWc(state: RouterState, wc: WebContents): AppSession | undefined {
  if (wc.isDestroyed()) return undefined
  const appSessionId = state.serviceWcIdToAppSessionId.get(wc.id)
  if (appSessionId) return state.appSessions.get(appSessionId)
  // A simulator wc hosts several sessions during a soft reload; a message that
  // doesn't name its session belongs to the LATEST still-alive spawn (the Set
  // preserves spawn order).
  const hosted = state.simulatorWcIdToAppSessionIds.get(wc.id)
  if (hosted) {
    let latest: AppSession | undefined
    for (const id of hosted) latest = state.appSessions.get(id) ?? latest
    if (latest) return latest
  }
  const bridgeId = state.wcIdToBridgeId.get(wc.id)
  if (bridgeId) {
    const page = state.pageSessions.get(bridgeId)
    if (page) return state.appSessions.get(page.appSessionId)
  }
  return undefined
}

/**
 * Whether `sender` is authorized to control app session `ap`. A simulator WCV
 * is authorized for EVERY session it hosts (`simulatorWcIdToAppSessionIds` is
 * a membership set, so an older session's own control traffic stays valid
 * while a newer spawn boots on the same wc); any other sender (service host,
 * render guest) resolves one-to-one through `appByWc`.
 */
export function senderBoundToSession(state: RouterState, sender: WebContents, ap: AppSession): boolean {
  if (sender.isDestroyed()) return false
  const hosted = state.simulatorWcIdToAppSessionIds.get(sender.id)
  if (hosted) return hosted.has(ap.appSessionId)
  return appByWc(state, sender)?.appSessionId === ap.appSessionId
}

export function resolveAppByBridgeId(state: RouterState, bridgeId: string): AppSession | undefined {
  if (state.appSessions.has(bridgeId)) return state.appSessions.get(bridgeId)
  const page = state.pageSessions.get(bridgeId)
  if (page) return state.appSessions.get(page.appSessionId)
  return undefined
}

export function bindWc(map: Map<number, string>, wc: WebContents, id: string): void {
  if (wc.isDestroyed()) return
  map.set(wc.id, id)
}

/** Add a session to a simulator wc's hosted set (created on first bind). */
export function bindSimulatorWc(map: Map<number, Set<string>>, wc: WebContents, id: string): void {
  if (wc.isDestroyed()) return
  let hosted = map.get(wc.id)
  if (!hosted) {
    hosted = new Set()
    map.set(wc.id, hosted)
  }
  hosted.add(id)
}

export function readBridgeId(msg: MessageEnvelope): string | undefined {
  return typeof msg.body?.bridgeId === 'string' ? msg.body.bridgeId : undefined
}

export function newBridgeId(): string {
  return `bridge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function resolveSimulatorWebContents(
  ctx: RuntimeContext,
  simulatorWcId: number | undefined,
  sender: WebContents,
): WebContents {
  if (!simulatorWcId) return sender ?? ctx.windows.mainWindow.webContents
  return webContents.fromId(simulatorWcId) ?? ctx.windows.mainWindow.webContents
}
