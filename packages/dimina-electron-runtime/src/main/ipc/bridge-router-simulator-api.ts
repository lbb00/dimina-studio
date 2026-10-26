import { randomUUID } from 'node:crypto'
import { nativeRequestOptions } from '../services/native-request/request-context.js'
import { STORAGE_API_NAMES } from '../services/storage.js'
import type { RuntimeContext } from '../runtime-context.js'
import type { NativeCloseSocketOptions, NativeConnectSocketOptions, NativeSendSocketMessageOptions, NativeWebSocketEventName } from '../services/native-websocket/index.js'
import { normalizeParams, sendCallback } from './bridge-router-callbacks.js'
import { handleNavigationSimulatorApi } from './bridge-router-api-navigation.js'
import { forwardApiCallToSimulator } from './bridge-router-api-transport.js'
import type { AppSession, PageSession, RouterState } from './bridge-router-types.js'

const onEvents = new Map<string, NativeWebSocketEventName>([['onSocketOpen', 'open'], ['onSocketMessage', 'message'], ['onSocketError', 'error'], ['onSocketClose', 'close']])
const offEvents = new Map<string, NativeWebSocketEventName>([['offSocketOpen', 'open'], ['offSocketMessage', 'message'], ['offSocketError', 'error'], ['offSocketClose', 'close']])
const nativeWebSocketNames = new Set(['connectSocket', 'sendSocketMessage', 'closeSocket', ...onEvents.keys(), ...offEvents.keys()])
const nativeHttpNames = new Set(['request', 'requestTaskAbort'])

async function invoke(ap: AppSession, name: string, params: Record<string, unknown>, call: () => Promise<unknown> | unknown): Promise<void> {
  try {
    const result = await call()
    const errMsg = result && typeof result === 'object' && 'errMsg' in result ? String((result as { errMsg?: unknown }).errMsg ?? '') : ''
    if (errMsg.startsWith(`${name}:fail`)) { sendCallback(ap, params.fail, result); sendCallback(ap, params.complete, result); return }
    sendCallback(ap, params.success, result); sendCallback(ap, params.complete, result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const fail = { errMsg: message.startsWith(`${name}:fail`) ? message : `${name}:fail ${message}` }
    sendCallback(ap, params.fail, fail); sendCallback(ap, params.complete, fail)
  }
}

async function nativeWebSocket(state: RouterState, ap: AppSession, name: string, params: Record<string, unknown>): Promise<void> {
  const onEvent = onEvents.get(name)
  if (onEvent) return registerSocketEvent(state, ap, onEvent, params)
  const offEvent = offEvents.get(name)
  if (offEvent) return unregisterSocketEvent(state, ap, offEvent, params)
  if (name === 'connectSocket') return connectSocket(state, ap, name, params)
  if (name === 'sendSocketMessage') return sendSocketMessage(state, ap, name, params)
  return closeSocket(state, ap, name, params)
}

function socketId(params: Record<string, unknown>): string { return typeof params.socketId === 'string' ? params.socketId : '' }

function registerSocketEvent(state: RouterState, ap: AppSession, event: NativeWebSocketEventName, params: Record<string, unknown>): void {
  state.nativeWebSocket.onSocketEvent(ap.appSessionId, event, { socketId: socketId(params), callback: params.callback }, (id, payload) => sendCallback(ap, id, payload))
}

function unregisterSocketEvent(state: RouterState, ap: AppSession, event: NativeWebSocketEventName, params: Record<string, unknown>): void {
  state.nativeWebSocket.offSocketEvent(ap.appSessionId, event, { socketId: socketId(params), callback: params.callback })
}

async function connectSocket(state: RouterState, ap: AppSession, name: string, params: Record<string, unknown>): Promise<void> {
  const configured = ap.appConfig.app?.networkTimeout?.connectSocket
  const timeout = socketTimeout(params.timeout, configured)
  const options: NativeConnectSocketOptions = { socketId: socketId(params), url: typeof params.url === 'string' ? params.url : '', header: params.header as Record<string, unknown> | undefined, protocols: params.protocols as string[] | undefined, timeout, perMessageDeflate: params.perMessageDeflate as boolean | undefined, tcpNoDelay: params.tcpNoDelay as boolean | undefined, forceCellularNetwork: params.forceCellularNetwork as boolean | undefined, containerReferer: `https://servicedimina.com/${ap.appId}/0/page-frame.html` }
  await invoke(ap, name, params, () => state.nativeWebSocket.connect(ap.appSessionId, options))
}

function socketTimeout(value: unknown, configured: unknown): number | undefined {
  if (typeof value === 'number' && value >= 1) return value
  return typeof configured === 'number' && Number.isFinite(configured) && configured >= 1 && configured <= 0x7fff_ffff ? configured : undefined
}

async function sendSocketMessage(state: RouterState, ap: AppSession, name: string, params: Record<string, unknown>): Promise<void> {
  const options: NativeSendSocketMessageOptions = { socketId: socketId(params), data: params.data, isBuffer: params.isBuffer === true }
  await invoke(ap, name, params, () => state.nativeWebSocket.send(ap.appSessionId, options))
}

async function closeSocket(state: RouterState, ap: AppSession, name: string, params: Record<string, unknown>): Promise<void> {
  const options: NativeCloseSocketOptions = { socketId: socketId(params), code: params.code as number | undefined, reason: params.reason as string | undefined }
  await invoke(ap, name, params, () => state.nativeWebSocket.close(ap.appSessionId, options))
}

export async function handleSimulatorApi(state: RouterState, ap: AppSession, page: PageSession, body: Record<string, unknown>, ctx: RuntimeContext, reportPageNotFound: (ctx: RuntimeContext, appSessionId: string, pagePath: string) => void): Promise<void> {
  const name = String(body.name ?? '')
  const params = normalizeParams(body.params)
  if (handleNavigationSimulatorApi(state, ap, page, name, params, reportPageNotFound, ctx)) return
  if (nativeWebSocketNames.has(name)) { await nativeWebSocket(state, ap, name, params); return }
  if (nativeHttpNames.has(name)) {
    const requestId = String(params.requestId ?? params.taskId ?? `${ap.appSessionId}:${name}:${randomUUID()}`)
    if (name === 'requestTaskAbort') state.nativeRequest.abort(ap.appSessionId, requestId)
    else await invoke(ap, name, params, () => state.nativeRequest.request(ap.appSessionId, requestId, nativeRequestOptions(params, ap.simulatorWc)))
    return
  }
  if (ctx.storageApi && STORAGE_API_NAMES.has(name)) { await invoke(ap, name, params, () => ctx.storageApi!.invoke(ap.appId, name, params)); return }
  if (ctx.simulatorApis.has(name)) { await invoke(ap, name, params, () => ctx.simulatorApis.invoke(name, params)); return }
  forwardApiCallToSimulator(state, ap, page, name, params)
}
