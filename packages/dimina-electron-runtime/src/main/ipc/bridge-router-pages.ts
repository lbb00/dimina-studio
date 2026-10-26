import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { NavCallbackPayload, PageClosePayload, PageLifecyclePayload, PageOpenRequest, PageOpenResult } from '../../shared/bridge-channels.js'
import { isTabPage, normalizePagePath, resolvePageWindowConfig } from './bridge-router-manifest.js'
import { sendCallback } from './bridge-router-callbacks.js'
import { disposePageSession } from './bridge-router-dispose.js'
import { forwardToService, newBridgeId, senderBoundToSession } from './bridge-router-transport.js'
import type { PageSession, RouterState } from './bridge-router-types.js'

export async function handlePageOpen(state: RouterState, event: IpcMainInvokeEvent, opts: PageOpenRequest): Promise<PageOpenResult> {
  const ap = state.appSessions.get(opts.appSessionId)
  if (!ap) throw new Error(`[bridge-router] PAGE_OPEN unknown appSession ${opts.appSessionId}`)
  if (!senderBoundToSession(state, event.sender, ap)) throw new Error('[bridge-router] PAGE_OPEN rejected: caller not bound to app session')
  const pagePath = normalizePagePath(opts.pagePath)
  if (ap.manifest.source === 'app-config' && !ap.manifest.pages.includes(pagePath)) throw new Error(`[bridge-router] PAGE_OPEN rejected: page-not-found "${pagePath}" is not in the compiled manifest`)
  const bridgeId = opts.bridgeId || newBridgeId()
  const windowConfig = resolvePageWindowConfig(ap.appConfig, pagePath)
  const isTab = isTabPage(ap.appConfig, pagePath)
  const page: PageSession = { bridgeId, appSessionId: opts.appSessionId, pagePath, query: opts.query ?? {}, isRoot: false, isTab, renderWc: null, renderLoaded: false, resourceLoadedSent: false, renderLoadPending: false, renderLoadSent: false, windowConfig, supersededRenderWcIds: new Set() }
  state.pageSessions.set(bridgeId, page)
  ap.pages.set(bridgeId, page)
  return { bridgeId, pagePath, windowConfig, isTab }
}

export function handlePageClose(state: RouterState, sender: WebContents, payload: PageClosePayload): void {
  const page = state.pageSessions.get(payload.bridgeId)
  if (!page) return
  const ap = state.appSessions.get(page.appSessionId)
  if (!ap) return
  if (page.isRoot && ap.pages.size <= 1) { console.warn("[bridge-router] PAGE_CLOSE refused on the session's only page; use DISPOSE"); return }
  if (!senderBoundToSession(state, sender, ap)) { console.warn('[bridge-router] PAGE_CLOSE rejected: caller not bound to app session'); return }
  disposePageSession(state, ap, page)
}

export function handlePageLifecycle(state: RouterState, sender: WebContents, payload: PageLifecyclePayload): void {
  const ap = state.appSessions.get(payload.appSessionId)
  if (!ap || !senderBoundToSession(state, sender, ap)) return
  if (payload.event === 'pageShow') ap.visibleBridgeId = payload.bridgeId
  else if ((payload.event === 'pageHide' || payload.event === 'pageUnload') && ap.visibleBridgeId === payload.bridgeId) ap.visibleBridgeId = null
  // While the host is backgrounded (see AppSession.hostHidden), a UI-driven
  // pageShow/pageHide is not a real WeChat show/hide — the page only becomes
  // actually visible once the host returns to the foreground, at which point
  // installAppLifecycleDriver's `show` sends pageShow for whatever page is
  // recorded as visible then. Forwarding here would race App.onHide/App.onShow
  // and could double-fire Page.onShow/onHide. pageUnload is a real teardown
  // regardless of host visibility, so it always forwards.
  if (ap.hostHidden && payload.event !== 'pageUnload') return
  forwardToService(ap, { type: payload.event, target: 'service', body: { bridgeId: payload.bridgeId } })
}

export function handleNavCallback(state: RouterState, sender: WebContents, payload: NavCallbackPayload): void {
  const ap = state.appSessions.get(payload.appSessionId)
  if (!ap || !senderBoundToSession(state, sender, ap)) return
  const result = { errMsg: payload.errMsg }
  sendCallback(ap, payload.ok ? payload.callbacks.success : payload.callbacks.fail, result)
  sendCallback(ap, payload.callbacks.complete, result)
}
