import { BRIDGE_CHANNELS as C } from "../../shared/bridge-channels.js"
import type { MessageEnvelope } from "../../shared/bridge-channels.js"
import type { RuntimeContext } from "../runtime-context.js"
import { markSessionRunning, pushRuntimeStatus } from "./bridge-router-lifecycle.js"
import { normalizePagePath } from "./bridge-router-manifest.js"
import { clearLaunchTimer } from "./bridge-router-state.js"
import { forwardToService } from "./bridge-router-transport.js"
import type { AppSession, PageSession, RouterState } from "./bridge-router-types.js"

const STACK_ID = "stack_0"

function rewriteSourceMappingUrl(source: string, scriptUrl: string): string {
  if (typeof source !== 'string' || !source) return source
  const re = /(^|\n)[ \t]*\/\/[#@][ \t]*sourceMappingURL=([^\n]*)/g
  let lastIndex = -1
  let lastValue = ''
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    lastIndex = m.index + (m[1]?.length ?? 0)
    lastValue = (m[2] || '').trim()
  }
  if (lastIndex < 0 || !lastValue) return source
  // Already absolute (scheme://, protocol-relative //host, or data:)? Leave it.
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(lastValue) || /^data:/i.test(lastValue)) return source
  let absolute: string
  try {
    absolute = new URL(lastValue, scriptUrl).toString()
  } catch {
    return source
  }
  return `${source.slice(0, lastIndex)}\n//# sourceMappingURL=${absolute}`
}

export async function bootServiceHost(
  state: RouterState,
  ap: AppSession,
  ctx: RuntimeContext,
): Promise<void> {
  // Liveness guard: never boot a session that was already disposed. With pooling,
  // the service window is recycled, so a stale did-finish-load listener from an
  // early-disposed prior owner could otherwise fire here and inject the wrong
  // app's logic.js into the next spawn (the recycled webContents is shared).
  if (state.appSessions.get(ap.appSessionId) !== ap) return
  // The service wc just did-finish-load'd, so its preload has (re-)run with
  // the real bridgeId and installed the TO_SERVICE listener — flip the gate
  // and flush anything `forwardToService` queued while it was still on the
  // warm/about:blank preload or mid-navigation, in the order it arrived.
  // Messages queued during the flush loop itself (none today; forwardToService
  // is synchronous) would still see serviceHostReady=true and send directly.
  ap.serviceHostReady = true
  if (ap.pendingServiceMessages.length > 0) {
    const queued = ap.pendingServiceMessages
    ap.pendingServiceMessages = []
    for (const msg of queued) forwardToService(ap, msg)
  }
  // The service wc just did-finish-load'd (that's how this got invoked) — flush
  // any diagnostic queued for this session (or the global bucket) into its now
  // resolvable console. Safe to call even when nothing is queued.
  ctx.consoleForwarder?.notifyServiceHostReady?.(ap.appSessionId)
  // Same authoritative moment, exposed as a general subscribable event (see
  // `ServiceHostReadyEvent`'s doc comment) — other main-process consumers
  // (the right-panel DevTools attach) need this exact signal too and must
  // not poll `getServiceWc` on a fixed retry budget for it.
  state.emitServiceHostReady({
    appId: ap.appId,
    appSessionId: ap.appSessionId,
    serviceWcId: ap.serviceWc.id,
  })
  ap.logicInjected = await injectLogicBundle(ap)
  if (!ap.logicInjected) {
    // The compiled logic.js never executed, so `modDefine` registered nothing.
    // Sending `loadResource` now would run `modRequire('app')` against an empty
    // registry and throw the cryptic `module app not found` — masking the real
    // cause (unreachable resource tree / failed compile / unresolved appId).
    // Skip it and surface one actionable diagnostic instead; the render side
    // gates on the same flag in `routeFromRender`.
    const reason = reportLogicLoadFailure(ap, ctx)
    clearLaunchTimer(ap)
    pushRuntimeStatus(ctx, ap, {
      phase: 'launch-failed',
      code: 'logic-bundle-unreachable',
      reason,
    })
    return
  }
  // A root page absent from the compiled manifest — most commonly a page the
  // developer deleted, then hot-reloaded to — is not registered in logic.js.
  // BOTH the service runtime AND the render runtime eager-`modRequire(pagePath)`
  // it and throw `module <pagePath> not found`, which aborts the launch and
  // leaves the simulator permanently blank. Gate BOTH sends and surface a
  // WeChat-style diagnostic instead: the shell stays alive (an empty phone frame
  // + a clear Console error) rather than a silent dead blank. Choosing a valid
  // fallback page belongs at the renderer reload source (it owns the pagePath
  // the render guest is spawned with); here we only refuse a load guaranteed to
  // throw, so main and render never disagree about which page is live.
  const rootPage = ap.pages.get(ap.appSessionId)
  const rootMissing = !!rootPage && !pageInManifest(ap, rootPage.pagePath)
  if (rootMissing) {
    reportPageNotFound(ctx, ap.appSessionId, rootPage.pagePath)
  }
  // Flush any render `loadResource` that arrived (renderHostReady) while
  // injection was in-flight — now that the bundle is confirmed present.
  // `sendRenderLoadResource` refuses a page absent from the manifest, so a
  // missing root never reaches the throwing render `modRequire`. This runs
  // BEFORE the service send below so render is loaded first, matching
  // upstream's own container (`Bridge.start` posts the webview's
  // `loadResource` ahead of the jscore's).
  for (const page of ap.pages.values()) {
    if (!page.renderLoadPending) continue
    page.renderLoadPending = false
    sendRenderLoadResource(ap, page)
  }
  if (rootMissing || !rootPage) return
  // A game's service `loadResource` synchronously `modRequire`s game.js, whose
  // top-level `wx.createCanvas()` messages render right away. Nothing buffers
  // that message, so a render guest that has not reported `renderHostReady`
  // yet never creates the canvas — and every later draw flush warns
  // `canvas node <id> not found` against a blank screen for the rest of the
  // session. Hold the send; `releaseDeferredServiceLoad` issues it the moment
  // the root render guest is listening.
  if (isGameSession(ap) && !rootPage.renderLoadSent) {
    ap.serviceLoadDeferred = true
    return
  }
  // serviceLoaded is flipped only when service responds with
  // `serviceResourceLoaded`; see handleContainerMsg. Setting it here would
  // race a per-page `resourceLoaded` ahead of the service-side handler.
  forwardToService(ap, makeLoadResource(ap, rootPage, 'service'))
}

/** Whether this session runs a compiled mini-game bundle (`runtimeType: 'game'`). */
function isGameSession(ap: AppSession): boolean {
  return ap.appConfig.app?.runtimeType === 'game'
}

/**
 * Issue the game service `loadResource` that `bootServiceHost` held back until
 * the root render guest was listening (see `AppSession.serviceLoadDeferred`).
 */
export function releaseDeferredServiceLoad(ap: AppSession, page: PageSession): void {
  if (!ap.serviceLoadDeferred || !page.isRoot || !page.renderLoadSent) return
  ap.serviceLoadDeferred = false
  forwardToService(ap, makeLoadResource(ap, page, 'service'))
}

export function sendRenderLoadResource(ap: AppSession, page: PageSession): void {
  if (!page.renderWc || page.renderWc.isDestroyed()) return
  // Single choke point for BOTH the boot flush above and the late
  // `renderHostReady` direct-send in `routeFromRender`: never send a render load
  // for a page absent from the compiled manifest. The render runtime
  // eager-`modRequire`s the pagePath and would throw `module <pagePath> not
  // found`, blanking the simulator (a page the developer deleted, then
  // hot-reloaded to). bootServiceHost surfaces the one-shot diagnostic.
  if (!pageInManifest(ap, page.pagePath)) return
  page.renderWc.send(C.TO_RENDER, {
    msg: makeLoadResource(ap, page, 'render'),
  })
  page.renderLoadSent = true
}

/** The compiled logic.js URL `injectLogicBundle` fetches (mode-dependent). */
function logicBundleUrl(ap: AppSession): string {
  return ap.resourceServer
    ? new URL('logic.js', ap.resourceBaseUrl).toString()
    : new URL(`${ap.appId}/${ap.root}/logic.js`, ap.resourceBaseUrl).toString()
}

async function injectLogicBundle(ap: AppSession): Promise<boolean> {
  // Fetch the compiled service logic over HTTP from the same base the render
  // host reads (`<base><appId>/<root>/logic.js`). The fallback local server
  // serves its root, so `<base>logic.js` resolves there too — both are http.
  const logicUrl = logicBundleUrl(ap)
  try {
    const res = await fetch(logicUrl)
    if (!res.ok) throw new Error(`logic.js fetch ${res.status} at ${logicUrl}`)
    // Rewrite the relative `sourceMappingURL` to an absolute dev-server URL
    // BEFORE injecting — `executeJavaScript` gives the script no base URL, so a
    // relative map would 404 and break sourcemapped console frames / Sources.
    const logicContent = rewriteSourceMappingUrl(await res.text(), logicUrl)
    await ap.serviceWc.executeJavaScript(`${logicContent}\n//# sourceURL=${logicUrl}`, true)
    return true
  } catch (error) {
    console.warn('[bridge-router] unable to inject service logic.js:', error)
    return false
  }
}

/**
 * Emit one actionable diagnostic when the compiled logic bundle could not be
 * loaded — the single point where "the app's compiled resource tree is
 * unreachable" is known with certainty. Reported through `ctx.diagnostics`,
 * which mirrors it to the main-process log AND — via `consoleForwarder`'s
 * subscription — injects it into the service host's own console, so it
 * actually surfaces in the embedded DevTools Console panel where the
 * developer would otherwise see only the misleading `module app not found`.
 * `guestConsole.emit` is kept alongside for the automation `App.logAdded`
 * subscriber, which does not consume the diagnostics bus.
 *
 * Returns the short (pre-hint) form of the message so `bootServiceHost` can
 * reuse it verbatim as the `sessionRuntimeStatus` `reason` instead of
 * duplicating the wording.
 */
function reportLogicLoadFailure(ap: AppSession, ctx: RuntimeContext): string {
  const hint =
    ap.appId === 'unknown'
      ? ' appId could not be resolved (it fell back to "unknown") — the mini-program likely failed to compile or its project manifest/app config is missing.'
      : ''
  const shortReason = `[dimina-studio] Failed to load the mini-program logic bundle from ${logicBundleUrl(ap)}.`
  const message =
    `${shortReason} ` +
    'The service runtime has no registered modules, so no page can mount.' +
    hint +
    ` Verify the project compiled successfully and that the resource server serves "${ap.appId}/${ap.root}/".`
  ctx.diagnostics?.report({
    severity: 'error',
    code: 'logic-bundle-unreachable',
    message,
    appSessionId: ap.appSessionId,
  })
  ctx.guestConsole?.emit({
    source: 'service',
    level: 'error',
    args: [message],
  })
  return shortReason
}

/** Whether `pagePath` still exists in the app's freshly compiled manifest. */
export function pageInManifest(ap: AppSession, pagePath: string): boolean {
  // A 'fallback' manifest (app-config.json unreachable) holds only the spawn
  // request — no compiled truth to check membership against. Every mount gate
  // keyed on manifest membership must agree: the nav/PAGE_OPEN front gates
  // already let a fallback manifest through, so this back gate (render
  // loadResource) must too, or a page they admitted silently never loads.
  if (ap.manifest.source !== 'app-config') return true
  return ap.manifest.pages.includes(normalizePagePath(pagePath))
}

/**
 * WeChat-devtools-style "page does not exist" diagnostic. Reported through
 * `ctx.diagnostics` (main log + injected into the embedded Console panel via
 * `consoleForwarder`) when a mount targets a pagePath that is not in the
 * compiled manifest — most commonly a page the developer deleted, then
 * hot-reloaded. `guestConsole.emit` is kept alongside for the automation
 * subscriber.
 */
export function reportPageNotFound(
  ctx: RuntimeContext,
  appSessionId: string,
  pagePath: string,
  fallbackTo?: string,
): void {
  const base =
    `Page[${pagePath}] not found. May be caused by: 1. Forgetting to add page route in app.json. ` +
    '2. Invoking Page() in async task.'
  const message = fallbackTo ? `${base} Falling back to "${fallbackTo}".` : base
  ctx.diagnostics?.report({
    severity: 'error',
    code: 'page-not-found',
    message,
    appSessionId,
  })
  ctx.guestConsole?.emit({
    source: 'service',
    level: 'error',
    args: [message],
  })
}

export function maybeSendResourceLoaded(ctx: RuntimeContext, ap: AppSession, page: PageSession): void {
  if (page.resourceLoadedSent || !ap.serviceLoaded || !page.renderLoaded) return
  page.resourceLoadedSent = true
  // Non-root pages (navigateTo / redirectTo / reLaunch / non-cached switchTab)
  // were never sent a SERVICE-side loadResource — only the root gets one at
  // bootServiceHost. Without it the service never `modRequire`s the page module,
  // so `getModuleByPath` misses and `createInstance` no-ops: the page mounts on
  // the render side but its service instance — and thus its AppData / WXML /
  // `Page.getData` — never exist. Mirror the render side, which sends
  // loadResource per page on `renderHostReady`. `loadResource` only registers
  // the module definition (no firstRender), and same-channel FIFO ordering
  // guarantees the module is registered before the `resourceLoaded` below runs
  // `createInstance`. Safety invariants 1-4 reviewed in
  // packages/devtools/docs/native-bridge-protocol.md.
  if (!page.isRoot) {
    forwardToService(ap, makeLoadResource(ap, page, 'service'))
  }
  forwardToService(ap, {
    type: 'resourceLoaded',
    target: 'service',
    body: {
      bridgeId: page.bridgeId,
      scene: ap.scene,
      pagePath: page.pagePath,
      query: page.query,
      stackId: STACK_ID,
    },
  })

  // Mini-games have no page-mount `domReady` — service's game runtime
  // (`isMiniGame()`) skips page-instance creation and never sends render a
  // `firstRender`, so `markSessionRunning`'s usual trigger never fires. Both
  // sides finishing `loadResource` (this function's own gate, just above) is
  // the earliest point either side signals anything back, and it's the same
  // moment upstream's own service runtime calls `gameLaunch()` — so treat it
  // as the game equivalent of `domReady` for clearing the launch watchdog.
  if (isGameSession(ap)) {
    markSessionRunning(ctx, ap, page)
  }
}

// ── Message routing ──────────────────────────────────────────────────────────


function makeLoadResource(
  ap: AppSession,
  page: PageSession,
  target: 'service' | 'render',
): MessageEnvelope {
  // Upstream's service handler (dimina/fe packages/service/src/index.js)
  // only threads `scene`/`query`/`referrerInfo` into `runtime.appLaunchOptions`
  // via `setAppLaunchOptions`, which itself no-ops once `this.app` exists
  // (core/runtime.js). `this.app` is created by the ROOT page's `loadResource`
  // (the first one to `modRequire('app')`), so only that send's values are
  // ever observed — later sends (non-root pages, render target) carry them
  // for nothing upstream, and this bundle has no per-page equivalent to set.
  // `referrerInfo` defaults to `{}` (WeChat's own default for a launch that
  // did not arrive via `wx.navigateToMiniProgram`); studio has no cross-app
  // open flow yet to source a real one from.
  const launchOptions =
    target === 'service' && page.isRoot
      ? { scene: ap.scene, query: page.query, referrerInfo: {} }
      : {}
  return {
    type: 'loadResource',
    target,
    body: {
      appId: ap.appId,
      bridgeId: page.bridgeId,
      pagePath: page.pagePath,
      root: ap.root,
      baseUrl: ap.resourceBaseUrl,
      resourceBaseUrl: ap.resourceBaseUrl,
      runtimeType: isGameSession(ap) ? 'game' : 'miniProgram',
      hostEnv: { systemInfo: ap.hostEnv, menuRect: null },
      ...launchOptions,
    },
  }
}

// ── Protocol handlers ───────────────────────────────────────────────────────
