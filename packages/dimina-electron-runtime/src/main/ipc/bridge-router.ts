import { createDebugTap } from 'electron-deck/main'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { createAppLifecycleController } from './app-lifecycle.js'
import { installAppLifecycleDriver } from './bridge-router-api-navigation.js'
import { createBridgeRouterHandle } from './bridge-router-handle.js'
import { installBridgeRouterIpc } from './bridge-router-ipc-install.js'
import type { BridgeRouterInstallDeps } from './bridge-router-install-deps.js'
export { LAUNCH_TIMEOUT_MS } from './bridge-router-lifecycle.js'
import { routerOwnsSender } from './bridge-router-ipc-mux.js'
import type { RouterState } from './bridge-router-types.js'
export type {
  BridgeOwnerSnapshot,
  BridgeResourceCensus,
  BridgeRouterHandle,
  RenderEvent,
  ServiceHostReadyEvent,
} from './bridge-router-types.js'
import { resolveRuntimeAssetPaths } from '../utils/paths.js'
import { serviceHostSpec } from '../windows/service-host-window/create.js'
import { ServiceHostPool } from '../services/service-host-pool/pool.js'
import { createNativeWebSocketService } from '../services/native-websocket/index.js'
import { createNativeRequestService } from '../services/native-request/index.js'
export type { NativeRequestTrace } from '../services/native-request/index.js'
export type { NativeWebSocketTrace } from '../services/native-websocket/index.js'
import type { RuntimeContext } from '../runtime-context.js'

const PREWARM_MAX_POOL_SIZE = 4

function resolvePrewarmPoolSize(): number {
  if (process.env.DIMINA_PREWARM_DISABLE === '1') return 0
  const raw = process.env.DIMINA_PREWARM_POOL_SIZE
  if (!raw) return 0
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? Math.min(n, PREWARM_MAX_POOL_SIZE) : 0
}

function resolveDebugTapEnabled(): boolean { return process.env.DIMINA_DEBUG_TAP === '1' }

function socketIdleTimeoutMsFromEnv(): number | undefined {
  const raw = process.env.DIMINA_SOCKET_IDLE_TIMEOUT_MS
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

export function installBridgeRouter(ctx: RuntimeContext): void {
  const runtimeAssets = ctx.assets ?? resolveRuntimeAssetPaths()
  ctx.assets = runtimeAssets
  const state: RouterState = {
    appSessions: new Map(), pageSessions: new Map(), serviceWcIdToAppSessionId: new Map(),
    simulatorWcIdToAppSessionIds: new Map(), wcIdToBridgeId: new Map(), pendingApiCalls: new Map(),
    pool: null, emitRenderEvent: () => {}, emitServiceHostReady: () => {}, lastServiceHostReady: null,
    connections: ctx.connections, debugTap: createDebugTap({ enabled: resolveDebugTapEnabled() }),
    appLifecycle: createAppLifecycleController(),
    hostBackgrounded: false,
    nativeWebSocket: createNativeWebSocketService({ idleTimeoutMs: socketIdleTimeoutMsFromEnv() }),
    nativeRequest: createNativeRequestService(),
    evictAppDataBridges: ap => {
      for (const page of ap.pages.values()) ctx.events.emit('app-data-evict', { appId: ap.appId, bridgeId: page.bridgeId })
    },
  }
  ctx.registry.add(() => state.nativeWebSocket.dispose())
  ctx.registry.add(() => state.nativeRequest.dispose())
  installPrewarmPool(ctx, state, runtimeAssets)
  installAppLifecycleDriver(ctx, state)
  const deps: BridgeRouterInstallDeps = {
    ctx, state, runtimeAssets,
    ownsSender: (event: IpcMainEvent | IpcMainInvokeEvent) => routerOwnsSender(state, ctx.windows?.mainWindow, event.sender),
  }
  const bridgeHandle = createBridgeRouterHandle(deps)
  installBridgeRouterIpc(deps, bridgeHandle)
}

function installPrewarmPool(ctx: RuntimeContext, state: RouterState, runtimeAssets: NonNullable<RuntimeContext['assets']>): void {
  const prewarmPoolSize = resolvePrewarmPoolSize()
  if (prewarmPoolSize <= 0) return
  const pool = new ServiceHostPool()
  state.pool = pool
  const warmTimer = setTimeout(() => {
    void pool.init({ defaultPoolSize: prewarmPoolSize, defaultSpec: serviceHostSpec(undefined, undefined, runtimeAssets), maxPoolSize: PREWARM_MAX_POOL_SIZE }).catch(error => console.warn('[bridge-router] webview pool warm-up failed:', error))
  }, 500)
  ctx.registry.add(() => clearTimeout(warmTimer))
  ctx.registry.add(() => state.pool?.dispose())
}
