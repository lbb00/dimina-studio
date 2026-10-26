import { SIMULATOR_EVENTS as E } from "../../shared/bridge-channels.js"
import type { MessageEnvelope } from "../../shared/bridge-channels.js"
import type { SyncStorageChange } from "../../shared/runtime-types.js"
import type { RuntimeContext } from "../runtime-context.js"
import type { GuestConsoleEntry } from "../services/console-forward/index.js"
import { syncAppVisibility } from "./bridge-router-api-navigation.js"
import { markSessionRunning } from "./bridge-router-lifecycle.js"
import { maybeSendResourceLoaded, releaseDeferredServiceLoad, reportPageNotFound, sendRenderLoadResource } from "./bridge-router-boot.js"
import { sendCallback } from "./bridge-router-callbacks.js"
import { forwardToRender, forwardToService, pageFromMsg, readBridgeId } from "./bridge-router-transport.js"
import { handleSimulatorApi } from "./bridge-router-simulator-api.js"
import type { AppSession, PageSession, RouterState } from "./bridge-router-types.js"

export function routeFromService(
  state: RouterState,
  ap: AppSession,
  defaultPage: PageSession,
  msg: MessageEnvelope,
  ctx: RuntimeContext,
): void {
  if (msg.type === 'serviceResourceLoaded') {
    handleContainerMsg(ap, defaultPage, msg, ctx, state)
    return
  }
  if (msg.target === 'render') {
    forwardToRender(ap, msg)
    return
  }
  if (msg.target === 'container') {
    const page = pageFromMsg(state, ap, msg) ?? defaultPage
    handleContainerMsg(ap, page, msg, ctx, state)
  }
}

export function routeFromRender(
  state: RouterState,
  ap: AppSession,
  page: PageSession,
  msg: MessageEnvelope,
  ctx: RuntimeContext,
): void {
  if (msg.type === 'renderHostReady') {
    // Logic injection definitively failed: the render bundle shares the same
    // (unreachable) resource tree, so `loadResource` here would only produce a
    // second cryptic `module <pagePath> not found`. bootServiceHost already
    // surfaced the actionable diagnostic — stay silent.
    if (ap.logicInjected === false) return
    // Injection still in-flight: the render guest fires `renderHostReady` on its
    // own DOMContentLoaded, which routinely beats the async fetch+inject. Hold
    // the render `loadResource` and let `bootServiceHost` flush it once the
    // bundle settles, so a failed bundle never reaches the render side.
    if (ap.logicInjected === null) {
      page.renderLoadPending = true
      return
    }
    sendRenderLoadResource(ap, page)
    releaseDeferredServiceLoad(ap, page)
    return
  }

  if (msg.type === 'renderResourceLoaded') {
    handleContainerMsg(ap, page, msg, ctx, state)
    return
  }

  if (msg.target === 'service') {
    forwardToService(ap, msg)
    return
  }
  if (msg.target === 'container') {
    handleContainerMsg(ap, page, msg, ctx, state)
  }
}

/**
 * Report 'service-uncaught-error' for a consoleLog(source:'service') body —
 * the service preload's uncaught error/unhandledrejection post. CDP's
 * `Runtime.consoleAPICalled` (services/service-console) never observes these
 * (they never call `console.*`), so this diagnostics report is the only way
 * one reaches the Console panel / main log.
 */
function reportServiceUncaughtError(
  ctx: RuntimeContext,
  ap: AppSession,
  body: GuestConsoleEntry,
): void {
  const severity = body.level === 'error' ? 'error' : body.level === 'warn' ? 'warn' : 'info'
  const message = Array.isArray(body.args)
    ? body.args.map(a => String(a)).join(' ')
    : String(body.args ?? '')
  ctx.diagnostics?.report({
    severity,
    code: 'service-uncaught-error',
    message,
    appSessionId: ap.appSessionId,
  })
}

function handleContainerMsg(
  ap: AppSession,
  page: PageSession,
  msg: MessageEnvelope,
  ctx: RuntimeContext,
  state: RouterState,
): void {
  switch (msg.type) {
    case 'serviceResourceLoaded':
      ap.serviceLoaded = true
      // Deliver any app-visibility change that happened before service was
      // ready (see syncAppVisibility) before the per-page resourceLoaded
      // handshake below — dimina bridge.ts's messageInvoke flushes app-level
      // visibility (notifyServiceReady) before page-level visibility
      // (#flushPageVisibility), in that same order, on this same message.
      syncAppVisibility(state, ap)
      for (const p of ap.pages.values()) maybeSendResourceLoaded(ctx, ap, p)
      break
    case 'renderResourceLoaded': {
      const target = readBridgeId(msg)
      const p = (target && ap.pages.get(target)) || page
      p.renderLoaded = true
      maybeSendResourceLoaded(ctx, ap, p)
      break
    }
    case 'domReady':
      if (!ap.simulatorWc.isDestroyed()) {
        ap.simulatorWc.send(E.DOM_READY, { bridgeId: page.bridgeId })
      }
      state.emitRenderEvent({
        kind: 'domReady',
        appId: ap.appId,
        bridgeId: page.bridgeId,
      })
      markSessionRunning(ctx, ap, page)
      break
    case 'invokeAPI':
      void handleSimulatorApi(state, ap, page, msg.body, ctx, reportPageNotFound)
      break
    case 'serviceHostError': {
      // Forward the error to every registered `wx.onError` listener. (The dimina
      // service runtime's App lifecycle is only onLaunch/onShow/onHide, so it
      // does not dispatch `App.onError` — `wx.onError` is the supported path.)
      // The service preload's `deliver` try/catch already reports errors thrown
      // during lifecycle/event dispatch here.
      const errBody = msg.body as { message?: unknown } | undefined
      const errArg = errBody?.message ?? msg.body
      // Reported through the diagnostics bus (main log + Console-panel
      // injection); `ctx.diagnostics.report` replaces the bare `console.warn`
      // this case used to make directly.
      ctx.diagnostics?.report({
        severity: 'error',
        code: 'service-host-error',
        message: String(errArg),
        appSessionId: ap.appSessionId,
      })
      for (const id of state.appLifecycle.listeners(ap.appSessionId, 'onError')) {
        sendCallback(ap, id, errArg)
      }
      break
    }
    case 'consoleLog': {
      // Native-host console capture: the render-host / service-host guest preloads
      // monkeypatch console.* and post each entry here (one case handles both —
      // distinguish via msg.body.source). Forward to the console sink (set by the
      // automation server under native-host) so it can rebroadcast as App.logAdded.
      // Guarded + non-throwing: console capture must never break message routing.
      ctx.guestConsole?.emit(msg.body)
      const body = msg.body as GuestConsoleEntry | undefined
      if (body?.source === 'service') reportServiceUncaughtError(ctx, ap, body)
      break
    }
    case 'storageChanged':
      // Native-host SYNC storage liveness: the service-host's `setStorageSync`/etc.
      // write `localStorage` directly (no main round-trip), so they post the change
      // here for the Storage panel to stay live. Trust `ap.appId` (sender-resolved),
      // not any appId in the body. Guarded + non-throwing.
      ctx.events.emit('storage-changed', {
        appId: ap.appId,
        change: msg.body as SyncStorageChange,
      })
      break
    case 'wxmlChanged':
      // Native-host WXML liveness: the render-guest MutationObserver posts this when
      // the active page's DOM mutated in place (setData). Surface it as a render
      // event so the WXML panel service re-pulls + pushes — same pipeline as
      // domReady/activePage. Trust `page.bridgeId` (sender-resolved), not the body.
      state.emitRenderEvent({
        kind: 'domMutated',
        appId: ap.appId,
        bridgeId: page.bridgeId,
      })
      break
    default:
      break
  }
}

// ── Resource helpers ────────────────────────────────────────────────────────

