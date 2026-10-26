import type { RuntimeContext } from '../runtime-context.js'
import { SIMULATOR_EVENTS as E } from '../../shared/bridge-channels.js'
import type { NavActionPayload, TabActionPayload } from '../../shared/bridge-channels.js'
import { buildPageScrollScript } from './page-scroll.js'
import { normalizePagePath } from './bridge-router-manifest.js'
import { extractCallbacks, sendCallback } from './bridge-router-callbacks.js'
import { forwardToService } from './bridge-router-transport.js'
import type { AppLifecycleEvent } from './app-lifecycle.js'
import type { AppSession, PageSession, RouterState } from './bridge-router-types.js'

const APP_LIFECYCLE_REGISTER: Record<string, AppLifecycleEvent> = { onAppShow: 'onAppShow', onAppHide: 'onAppHide', onError: 'onError' }
const APP_LIFECYCLE_UNREGISTER: Record<string, AppLifecycleEvent> = { offAppShow: 'onAppShow', offAppHide: 'onAppHide', offError: 'onError' }

/**
 * Deliver (or withhold) the app/page visibility pair implied by `ap.hostHidden`
 * to this session's service, mirroring dimina jscore.ts's
 * desiredAppVisible/sentAppVisible split: `hostHidden` is the desired
 * direction, `appHiddenSent` is what was actually delivered. Before
 * `serviceLoaded` (service's App instance constructed), `runtime.appHide()/
 * appShow()` silently no-op and are never redelivered, so this only sends
 * once `ap.serviceLoaded` is true — called both by the driver on a real
 * host edge and by the `serviceResourceLoaded` handler once loading catches
 * up to a `hostHidden` that changed while the service wasn't ready yet.
 * WeChat orders a hide as Page.onHide → App.onHide, and a show as
 * App.onShow → Page.onShow (dimina/docs/MiniProgram-Retention.md; also the
 * order dimina bridge.ts flushes app-level then page-level visibility on
 * `serviceResourceLoaded`).
 */
export function syncAppVisibility(state: RouterState, ap: AppSession): void {
  if (!ap.serviceLoaded) return
  if (ap.appHiddenSent === ap.hostHidden) return
  if (ap.hostHidden) {
    if (ap.visibleBridgeId) forwardToService(ap, { type: 'pageHide', target: 'service', body: { bridgeId: ap.visibleBridgeId } })
    forwardToService(ap, { type: 'appHide', target: 'service', body: {} })
    for (const id of state.appLifecycle.listeners(ap.appSessionId, 'onAppHide')) sendCallback(ap, id, {})
  } else {
    forwardToService(ap, { type: 'appShow', target: 'service', body: {} })
    if (ap.visibleBridgeId) forwardToService(ap, { type: 'pageShow', target: 'service', body: { bridgeId: ap.visibleBridgeId } })
    for (const id of state.appLifecycle.listeners(ap.appSessionId, 'onAppShow')) sendCallback(ap, id, {})
  }
  ap.appHiddenSent = ap.hostHidden
}

export function installAppLifecycleDriver(ctx: RuntimeContext, state: RouterState): void {
  const win = ctx.windows?.mainWindow
  if (!win || typeof win.on !== 'function') return
  // WeChat orders a hide as Page.onHide → App.onHide, and a show as
  // App.onShow → Page.onShow — see `syncAppVisibility`, which does the
  // actual (possibly deferred) delivery. This driver only owns the two
  // per-edge dedups: `state.hostBackgrounded` (shared physical host state,
  // `hide`/`minimize` and `show`/`restore` can each fire for the same
  // foreground↔background edge) and each ap's own `hostHidden` (see
  // AppSession.hostHidden) so a page mounted while the host is still
  // backgrounded doesn't count as shown until the host actually returns to
  // the foreground.
  const hide = (): void => {
    if (!state.hostBackgrounded) { state.hostBackgrounded = true; state.nativeWebSocket.setBackgrounded(true) }
    for (const ap of state.appSessions.values()) {
      if (ap.hostHidden) continue
      ap.hostHidden = true
      syncAppVisibility(state, ap)
    }
  }
  const show = (): void => {
    if (state.hostBackgrounded) { state.hostBackgrounded = false; state.nativeWebSocket.setBackgrounded(false) }
    for (const ap of state.appSessions.values()) {
      if (!ap.hostHidden) continue
      ap.hostHidden = false
      syncAppVisibility(state, ap)
    }
  }
  const onShow = (): void => {
    if (!win.isMinimized()) show()
  }
  win.on('hide', hide); win.on('minimize', hide); win.on('show', onShow); win.on('restore', show)
  ctx.registry.add(() => { win.off('hide', hide); win.off('minimize', hide); win.off('show', onShow); win.off('restore', show) })
}

function failActionCallback(ap: AppSession, params: Record<string, unknown>, errMsg: string): void {
  const fail = { errMsg }; sendCallback(ap, params.fail, fail); sendCallback(ap, params.complete, fail)
}

function sendActionOrFail(ap: AppSession, eventName: string, payload: NavActionPayload | TabActionPayload, name: string, params: Record<string, unknown>): void {
  if (!ap.simulatorWc.isDestroyed()) { ap.simulatorWc.send(eventName, payload); return }
  failActionCallback(ap, params, `${name}:fail simulator window destroyed`)
}

function checkNavTarget(ap: AppSession, name: string, targetPagePath: string): { ok: boolean; errMsg?: string; reportNotFound?: boolean } {
  if (ap.manifest.source !== 'app-config') return { ok: true }
  if (!ap.manifest.pages.includes(targetPagePath)) return { ok: false, errMsg: `${name}:fail page "${targetPagePath}" is not found`, reportNotFound: true }
  if (name === 'switchTab' && !ap.manifest.tabBar?.list.some(item => normalizePagePath(item.pagePath) === targetPagePath)) return { ok: false, errMsg: 'switchTab:fail can not switch to no-tabBar page' }
  return { ok: true }
}

export function handleNavigationSimulatorApi(state: RouterState, ap: AppSession, page: PageSession, name: string, params: Record<string, unknown>, reportPageNotFound: (ctx: RuntimeContext, appSessionId: string, pagePath: string) => void, ctx: RuntimeContext): boolean {
  if (NAV_BAR_API_NAMES.has(name)) {
    handleNavBar(ap, page, name, params)
    return true
  }
  if (NAV_ACTION_NAMES.has(name)) {
    handleNavAction(ap, page, name, params, reportPageNotFound, ctx)
    return true
  }
  if (TAB_ACTION_NAMES.has(name)) {
    sendActionOrFail(ap, E.TAB_ACTION, { appSessionId: ap.appSessionId, bridgeId: page.bridgeId, name: name as TabActionPayload['name'], params, callbacks: extractCallbacks(params) }, name, params)
    return true
  }
  const register = APP_LIFECYCLE_REGISTER[name]
  if (register) { state.appLifecycle.register(ap.appSessionId, register, params.success); return true }
  const unregister = APP_LIFECYCLE_UNREGISTER[name]
  if (unregister) { state.appLifecycle.unregister(ap.appSessionId, unregister, params.success); return true }
  if (name !== 'pageScrollTo') return false
  handlePageScroll(page, ap, params)
  return true
}

function handleNavBar(ap: AppSession, page: PageSession, name: string, params: Record<string, unknown>): void {
  if (!ap.simulatorWc.isDestroyed()) ap.simulatorWc.send(E.NAV_BAR, { bridgeId: page.bridgeId, name, params })
  const result = { errMsg: `${name}:ok` }; sendCallback(ap, params.success, result); sendCallback(ap, params.complete, result)
}

function handleNavAction(ap: AppSession, page: PageSession, name: string, params: Record<string, unknown>, reportPageNotFound: (ctx: RuntimeContext, appSessionId: string, pagePath: string) => void, ctx: RuntimeContext): void {
  const raw = params.url
  const targetPagePath = typeof raw === 'string' && raw ? normalizePagePath(raw.split('?')[0] ?? raw) : undefined
  if (targetPagePath) {
    const verdict = checkNavTarget(ap, name, targetPagePath)
    if (!verdict.ok) {
      if (verdict.reportNotFound) reportPageNotFound(ctx, ap.appSessionId, targetPagePath)
      failActionCallback(ap, params, verdict.errMsg!)
      return
    }
  }
  sendActionOrFail(ap, E.NAV_ACTION, { appSessionId: ap.appSessionId, bridgeId: page.bridgeId, name: name as NavActionPayload['name'], params, callbacks: extractCallbacks(params) }, name, params)
}

function handlePageScroll(page: PageSession, ap: AppSession, params: Record<string, unknown>): void {
  const renderWc = page.renderWc
  if (renderWc && !renderWc.isDestroyed()) void renderWc.executeJavaScript(buildPageScrollScript(params)).catch(() => {})
  const result = { errMsg: 'pageScrollTo:ok' }; sendCallback(ap, params.success, result); sendCallback(ap, params.complete, result)
}

const NAV_BAR_API_NAMES = new Set(['setNavigationBarTitle', 'setNavigationBarColor', 'showNavigationBarLoading', 'hideNavigationBarLoading', 'hideHomeButton'])
const NAV_ACTION_NAMES = new Set(['navigateTo', 'redirectTo', 'navigateBack', 'reLaunch', 'switchTab'])
const TAB_ACTION_NAMES = new Set(['showTabBar', 'hideTabBar', 'setTabBarStyle', 'setTabBarItem', 'showTabBarRedDot', 'hideTabBarRedDot', 'setTabBarBadge', 'removeTabBarBadge'])
