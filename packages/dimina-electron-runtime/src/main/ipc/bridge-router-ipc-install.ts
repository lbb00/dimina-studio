import { ipcMain } from 'electron'
import type { IpcMainEvent, WebContents } from 'electron'
import { pathToFileURL } from 'node:url'
import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type { ActivePagePayload, ApiResponsePayload, NativeHostConfig, NavCallbackPayload, PageClosePayload, PageLifecyclePayload, PageOpenRequest, PageOpenResult, PageStackPayload, RenderInvokePayload, RenderPublishPayload, ServiceInvokePayload, ServicePublishPayload, SpawnRequest, SpawnResult } from '../../shared/bridge-channels.js'
import { handleDmbResourceRequest } from '../services/dmb-resource/handle-request.js'
import type { DmbResourceSession } from '../services/dmb-resource/handle-request.js'
import { buildRenderHostDocumentUrl } from '../services/dmb-resource/render-host-url.js'
import { resolveMapConfigEnv } from '../utils/map-config.js'
import { handleApiResponse } from './bridge-router-api-transport.js'
import { disposeAppSession } from './bridge-router-dispose.js'
import type { BridgeRouterInstallDeps } from './bridge-router-install-deps.js'
import { addMuxedInvokeHandler, addMuxedSyncListener } from './bridge-router-ipc-mux.js'
import { handleNavCallback, handlePageClose, handlePageLifecycle, handlePageOpen } from './bridge-router-pages.js'
import { addMuxedDmbResourceHandler } from './bridge-router-protocol-mux.js'
import { routeFromRender, routeFromService } from './bridge-router-route.js'
import { handleSpawn } from './bridge-router-spawn.js'
import { activePageOf } from './bridge-router-state.js'
import { appByWc, ensureRenderBound, forwardToRender, forwardToService, pageFromMsg, resolveAppByBridgeId, senderBoundToSession } from './bridge-router-transport.js'
import type { BridgeRouterHandle } from './bridge-router-types.js'

type IpcMainListener = Parameters<typeof ipcMain.on>[1]

export function installBridgeRouterIpc(deps: BridgeRouterInstallDeps, handle: BridgeRouterHandle): void {
  const { ctx, state, runtimeAssets, ownsSender } = deps
  const onNativeHostQuery = (event: IpcMainEvent): void => {
    const reply: NativeHostConfig = {
      enabled: true,
      renderHostHtmlUrl: buildRenderHostDocumentUrl({ bridgeId: '_', appId: '_', root: '_', pagePath: '_' }),
      renderPreloadUrl: pathToFileURL(runtimeAssets!.renderHostPreloadPath).toString(),
      device: handle.getDevice() ?? undefined,
      mapConfig: resolveMapConfigEnv(),
    }
    event.returnValue = reply
  }
  ctx.registry.add(addMuxedSyncListener(C.NATIVE_HOST_ENABLED, { claims: ownsSender, handle: onNativeHostQuery }))
  installResourceProtocolHandlers(deps)

  const onActivePage = (event: IpcMainEvent, payload: ActivePagePayload): void => {
    const ap = state.appSessions.get(payload.appSessionId)
    if (!ap || !senderBoundToSession(state, event.sender, ap) || !ap.pages.has(payload.bridgeId)) return
    ap.activeBridgeId = payload.bridgeId
    const page = state.pageSessions.get(payload.bridgeId)
    state.emitRenderEvent({ kind: 'activePage', appId: ap.appId, bridgeId: payload.bridgeId, pagePath: page?.pagePath, query: page?.query })
  }
  addListener(C.ACTIVE_PAGE, onActivePage)
  const onPageStack = (event: IpcMainEvent, payload: PageStackPayload): void => {
    const ap = state.appSessions.get(payload.appSessionId)
    if (ap && senderBoundToSession(state, event.sender, ap)) ap.pageStack = payload.stack
  }
  addListener(C.PAGE_STACK, onPageStack)
  ctx.registry.add(addMuxedInvokeHandler(C.SPAWN, { claims: ownsSender, handle: (event, opts): Promise<SpawnResult> => handleSpawn(state, ctx, event, opts as SpawnRequest) }))
  ctx.registry.add(addMuxedInvokeHandler(C.PAGE_OPEN, { claims: ownsSender, handle: (event, opts): Promise<PageOpenResult> => handlePageOpen(state, event, opts as PageOpenRequest) }))
  addListener(C.PAGE_CLOSE, (event, payload: PageClosePayload) => handlePageClose(state, event.sender, payload))
  addListener(C.PAGE_LIFECYCLE, (event, payload: PageLifecyclePayload) => {
    handlePageLifecycle(state, event.sender, payload)
    if (payload.event !== 'pageUnload') return
    const ap = state.appSessions.get(payload.appSessionId)
    if (ap && senderBoundToSession(state, event.sender, ap)) ctx.events.emit('app-data-evict', { appId: ap.appId, bridgeId: payload.bridgeId })
  })
  addListener(C.NAV_CALLBACK, (event, payload: NavCallbackPayload) => handleNavCallback(state, event.sender, payload))
  addListener(C.DISPOSE, (event, payload: unknown) => {
    const bridgeId = disposeBridgeId(payload)
    if (!bridgeId) return
    const target = resolveAppByBridgeId(state, bridgeId)
    if (!target) return
    if (!senderBoundToSession(state, event.sender, target)) {
      console.warn(`[bridge-router] DISPOSE rejected: sender not bound to target ${target.appSessionId}`)
      return
    }
    void disposeAppSession(state, target.appSessionId)
  })

  const tapIn = (channel: string, sender: WebContents, payload: unknown): void => {
    if (!state.debugTap.enabled) return
    state.debugTap.record({ ts: Date.now(), channel, direction: 'in', connectionId: sender.id, sessionId: appByWc(state, sender)?.appSessionId, summary: summarizeBridgeMsg(payload) })
  }
  addListener(C.SERVICE_INVOKE, (event, payload: ServiceInvokePayload) => {
    tapIn(C.SERVICE_INVOKE, event.sender, payload)
    const ap = appByWc(state, event.sender)
    const page = ap && (pageFromMsg(state, ap, payload.msg) ?? activePageOf(state, ap))
    if (ap && page) routeFromService(state, ap, page, payload.msg, ctx)
  })
  addListener(C.SERVICE_PUBLISH, (event, payload: ServicePublishPayload) => {
    tapIn(C.SERVICE_PUBLISH, event.sender, payload)
    const ap = appByWc(state, event.sender)
    if (!ap) return
    forwardToRender(ap, payload.msg, payload.targetBridgeId)
    ctx.events.emit('app-data-message', { appId: ap.appId, message: payload.msg })
  })
  addListener(C.RENDER_INVOKE, (event, payload: RenderInvokePayload) => {
    tapIn(C.RENDER_INVOKE, event.sender, payload)
    const page = ensureRenderBound(state, event.sender, payload.bridgeId)
    const ap = page && state.appSessions.get(page.appSessionId)
    if (ap && page) routeFromRender(state, ap, page, payload.msg, ctx)
  })
  addListener(C.RENDER_PUBLISH, (event, payload: RenderPublishPayload) => {
    tapIn(C.RENDER_PUBLISH, event.sender, payload)
    const page = ensureRenderBound(state, event.sender, payload.bridgeId)
    const ap = page && state.appSessions.get(page.appSessionId)
    if (ap) forwardToService(ap, payload.msg)
  })
  ctx.registry.add(addMuxedInvokeHandler(C.SIMULATOR_API, { claims: ownsSender, handle: (_event, payload) => {
    const call = payload as { name: string; params: unknown }
    return ctx.simulatorApis.invoke(call.name, call.params)
  } }))
  addListener(C.API_RESPONSE, (event, payload: ApiResponsePayload) => {
    tapIn(C.API_RESPONSE, event.sender, payload)
    handleApiResponse(state, event.sender, payload)
  })
  ctx.registry.add(async () => {
    for (const pending of state.pendingApiCalls.values()) clearTimeout(pending.timer)
    state.pendingApiCalls.clear()
  })
  ctx.registry.add(async () => { await Promise.all(Array.from(state.appSessions.keys()).map(id => disposeAppSession(state, id))) })
  function addListener(channel: string, listener: IpcMainListener): void {
    ipcMain.on(channel, listener)
    ctx.registry.add(() => {
      ipcMain.removeListener(channel, listener)
    })
  }
}

function installResourceProtocolHandlers({ ctx, state, runtimeAssets }: BridgeRouterInstallDeps): void {
  const resolveSession = (bridgeId: string): DmbResourceSession | null => {
    const ap = resolveAppByBridgeId(state, bridgeId)
    return ap ? {
      resourceBaseUrl: ap.resourceBaseUrl,
      appId: ap.appId,
      root: ap.root,
      partition: ap.resourcePartition,
    } : null
  }
  ctx.registry.add(addMuxedDmbResourceHandler({
    claims: (requestUrl, requestPartition) => {
      try { return resolveSession(new URL(requestUrl).hostname)?.partition === requestPartition } catch { return false }
    },
    handle: (request, requestPartition) => handleDmbResourceRequest({ requestUrl: request.url, requestPartition, sdkRoot: runtimeAssets!.root, resolveSession }),
  }))
}

function summarizeBridgeMsg(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const p = payload as Record<string, unknown>
  const bridgeId = typeof p.bridgeId === 'string' ? p.bridgeId : undefined
  const msg = p.msg as Record<string, unknown> | undefined
  const type = msg && typeof msg.type === 'string' ? msg.type : undefined
  const parts = [type, bridgeId ? `bridge=${bridgeId}` : undefined].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : undefined
}

function disposeBridgeId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const bridgeId = (payload as Record<string, unknown>).bridgeId
  return typeof bridgeId === 'string' && bridgeId.length > 0 ? bridgeId : null
}
