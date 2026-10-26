import type { NativeDeviceInfo } from '../../shared/runtime-types.js'
import { SIMULATOR_EVENTS as E } from '../../shared/bridge-channels.js'
import { applyDeviceToSession } from './bridge-router-device-geometry.js'
import { disposeAppSession } from './bridge-router-dispose.js'
import type { BridgeRouterInstallDeps } from './bridge-router-install-deps.js'
import { resolveActiveBridgeId, resolveCurrentApp } from './bridge-router-state.js'
import { forwardToService } from './bridge-router-transport.js'
import type { BridgeOwnerSnapshot } from './bridge-owner-snapshot.js'
import type {
  BridgeResourceCensus,
  BridgeRouterHandle,
  RenderEvent,
  ServiceHostReadyEvent,
} from './bridge-router-types.js'
import type { NativeRequestTrace } from '../services/native-request/index.js'
import type { NativeWebSocketTrace } from '../services/native-websocket/index.js'
import { createConsoleForwarder } from '../services/console-forward/index.js'
import { createDiagnosticsBus } from '../services/diagnostics/index.js'

export function createBridgeRouterHandle(deps: BridgeRouterInstallDeps): BridgeRouterHandle {
  const { ctx, state } = deps
  let currentDevice: NativeDeviceInfo | null = null
  const renderEventListeners = new Set<(event: RenderEvent) => void>()
  const serviceHostReadyListeners = new Set<(event: ServiceHostReadyEvent) => void>()
  const nativeWebSocketTraceListeners = new Set<(ownerId: string, event: NativeWebSocketTrace) => void>()
  const nativeRequestTraceListeners = new Set<(ownerId: string, event: NativeRequestTrace) => void>()

  state.emitRenderEvent = event => {
    for (const listener of renderEventListeners) {
      try { listener(event) } catch (error) { console.warn('[bridge-router] render-event listener threw:', error) }
    }
  }
  state.emitServiceHostReady = event => {
    state.lastServiceHostReady = event
    for (const listener of serviceHostReadyListeners) {
      try { listener(event) } catch (error) { console.warn('[bridge-router] service-host-ready listener threw:', error) }
    }
  }
  state.nativeWebSocket.setTracer((ownerId, event) => {
    for (const listener of nativeWebSocketTraceListeners) {
      try { listener(ownerId, event) } catch (error) { console.warn('[bridge-router] websocket-trace listener threw:', error) }
    }
  })
  state.nativeRequest.setTracer((ownerId, event) => {
    for (const listener of nativeRequestTraceListeners) {
      try { listener(ownerId, event) } catch (error) { console.warn('[bridge-router] request-trace listener threw:', error) }
    }
  })
  ctx.registry.add(() => nativeWebSocketTraceListeners.clear())
  ctx.registry.add(() => nativeRequestTraceListeners.clear())

  const handle: BridgeRouterHandle = {
    isNativeHost: () => true,
    resolveRenderWc: bridgeId => {
      const page = state.pageSessions.get(bridgeId)
      return page?.renderWc && !page.renderWc.isDestroyed() ? page.renderWc : null
    },
    getServiceWc: appId => {
      const ap = resolveCurrentApp(state, ctx, appId)
      return ap && !ap.serviceWc.isDestroyed() ? ap.serviceWc : null
    },
    getServiceWcForBridge: bridgeId => {
      const page = state.pageSessions.get(bridgeId)
      const ap = page && state.appSessions.get(page.appSessionId)
      return ap && !ap.serviceWc.isDestroyed() ? ap.serviceWc : null
    },
    getActiveBridgeId: appId => {
      const ap = resolveCurrentApp(state, ctx, appId)
      return ap ? resolveActiveBridgeId(ap) : null
    },
    getPageStack: appId => resolveCurrentApp(state, ctx, appId)?.pageStack ?? null,
    getResourceBaseUrl: appId => resolveCurrentApp(state, ctx, appId)?.resourceBaseUrl ?? null,
    getActiveRenderWc: appId => {
      const ap = resolveCurrentApp(state, ctx, appId)
      const bridgeId = ap && resolveActiveBridgeId(ap)
      const page = bridgeId ? state.pageSessions.get(bridgeId) : undefined
      return page?.renderWc && !page.renderWc.isDestroyed() ? page.renderWc : null
    },
    listOwnerSnapshots: (): BridgeOwnerSnapshot[] => {
      const owners = new Map<number, BridgeOwnerSnapshot>()
      for (const session of state.appSessions.values()) {
        if (!session.serviceWc.isDestroyed()) {
          owners.set(session.serviceWc.id, {
            webContentsId: session.serviceWc.id,
            sessionId: session.appSessionId,
            role: 'service-host',
          })
        }
      }
      for (const page of state.pageSessions.values()) {
        if (!page.renderWc || page.renderWc.isDestroyed()) continue
        owners.set(page.renderWc.id, {
          webContentsId: page.renderWc.id,
          sessionId: page.appSessionId,
          role: 'render-page',
        })
      }
      return [...owners.values()]
    },
    onRenderEvent: listener => {
      renderEventListeners.add(listener)
      return () => renderEventListeners.delete(listener)
    },
    onServiceHostReady: listener => {
      serviceHostReadyListeners.add(listener)
      const candidate = state.lastServiceHostReady
      if (candidate) queueMicrotask(() => {
        if (!serviceHostReadyListeners.has(listener)) return
        const ap = state.appSessions.get(candidate.appSessionId)
        if (!ap || ap.serviceWc.isDestroyed() || ap.serviceWc.id !== candidate.serviceWcId) return
        try { listener(candidate) } catch (error) { console.warn('[bridge-router] service-host-ready catch-up listener threw:', error) }
      })
      return () => serviceHostReadyListeners.delete(listener)
    },
    onNativeWebSocketTrace: listener => {
      nativeWebSocketTraceListeners.add(listener)
      return () => nativeWebSocketTraceListeners.delete(listener)
    },
    onNativeRequestTrace: listener => {
      nativeRequestTraceListeners.add(listener)
      return () => nativeRequestTraceListeners.delete(listener)
    },
    getDevice: () => currentDevice,
    setDevice: device => {
      currentDevice = device
      const seen = new Set<number>()
      for (const ap of state.appSessions.values()) {
        for (const msg of applyDeviceToSession(ap, device)) forwardToService(ap, msg)
        const wc = ap.simulatorWc
        if (wc && !wc.isDestroyed() && !seen.has(wc.id)) {
          seen.add(wc.id)
          wc.send(E.DEVICE_CHANGE, device)
        }
      }
    },
    disposeSessionsForSimulator: simulatorWcId => {
      const ids = Array.from(state.appSessions, ([id, ap]) => ap.simulatorWc.id === simulatorWcId ? id : undefined)
        .filter((id): id is string => id !== undefined)
      return Promise.all(ids.map(id => disposeAppSession(state, id))).then(() => {})
    },
    debugTap: state.debugTap,
    census: (): BridgeResourceCensus => {
      const simulatorDestroyedListeners: Record<number, number> = {}
      let simulatorWcBindings = 0
      for (const ids of state.simulatorWcIdToAppSessionIds.values()) simulatorWcBindings += ids.size
      for (const ap of state.appSessions.values()) {
        const wc = ap.simulatorWc
        if (!wc.isDestroyed() && simulatorDestroyedListeners[wc.id] === undefined) simulatorDestroyedListeners[wc.id] = wc.listenerCount('destroyed')
      }
      return { appSessions: state.appSessions.size, pageSessions: state.pageSessions.size, serviceWcBindings: state.serviceWcIdToAppSessionId.size, simulatorWcs: state.simulatorWcIdToAppSessionIds.size, simulatorWcBindings, renderWcBindings: state.wcIdToBridgeId.size, pendingApiCalls: state.pendingApiCalls.size, simulatorDestroyedListeners }
    },
  }
  ctx.bridge = handle
  if (process.env.NODE_ENV === 'test') {
    const globalState = globalThis as Record<string, unknown>
    const censusProbe = () => handle.census?.()
    globalState.__diminaResourceCensus = censusProbe
    globalState.__diminaBridgeHandle = handle
    ctx.registry.add(() => {
      if (globalState.__diminaResourceCensus === censusProbe) delete globalState.__diminaResourceCensus
      if (globalState.__diminaBridgeHandle === handle) delete globalState.__diminaBridgeHandle
    })
  }
  installBridgeRouterDiagnostics(ctx, handle)
  return handle
}

function installBridgeRouterDiagnostics(ctx: BridgeRouterInstallDeps['ctx'], bridgeHandle: BridgeRouterHandle): void {
  const ownsDiagnosticsBus = ctx.diagnostics === undefined
  const diagnosticsBus = ctx.diagnostics ?? createDiagnosticsBus()
  ctx.diagnostics = diagnosticsBus
  const consoleForwarder = createConsoleForwarder(bridgeHandle, diagnosticsBus)
  ctx.consoleForwarder = consoleForwarder
  ctx.guestConsole = consoleForwarder
  ctx.registry.add(() => {
    void consoleForwarder.dispose()
    ctx.consoleForwarder = undefined
    ctx.guestConsole = undefined
    if (ownsDiagnosticsBus) {
      diagnosticsBus.dispose()
      ctx.diagnostics = undefined
    }
  })
}
