import { apiCallWatchdogMs, isPersistentSimulatorApi } from '../../shared/simulator-api-metadata.js'
import { SIMULATOR_EVENTS as E } from '../../shared/bridge-channels.js'
import type { ApiCallPayload, ApiResponsePayload } from '../../shared/bridge-channels.js'
import type { WebContents } from 'electron'
import { extractCallbacks, sendCallback } from './bridge-router-callbacks.js'
import { senderBoundToSession } from './bridge-router-transport.js'
import type { AppSession, PageSession, RouterState } from './bridge-router-types.js'

export function forwardApiCallToSimulator(state: RouterState, ap: AppSession, page: PageSession, name: string, params: Record<string, unknown>): void {
  const callbacks = extractCallbacks(params)
  if (ap.simulatorWc.isDestroyed()) {
    const fail = { errMsg: `${name}:fail simulator window destroyed` }
    sendCallback(ap, callbacks.fail, fail)
    sendCallback(ap, callbacks.complete, fail)
    return
  }
  const requestId = `apicall_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const keep = params.keep === true || isPersistentSimulatorApi(name)
  const timer = keep ? undefined : setTimeout(() => {
    const pending = state.pendingApiCalls.get(requestId)
    if (!pending) return
    state.pendingApiCalls.delete(requestId)
    const target = state.appSessions.get(pending.appSessionId)
    if (!target) return
    const fail = { errMsg: `${pending.name}:fail no handler (timeout)` }
    sendCallback(target, pending.callbacks.fail, fail)
    sendCallback(target, pending.callbacks.complete, fail)
  }, apiCallWatchdogMs(name, params))
  state.pendingApiCalls.set(requestId, { appSessionId: ap.appSessionId, callbacks, name, timer })
  const forwardedParams: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (key !== 'success' && key !== 'fail' && key !== 'complete') forwardedParams[key] = value
  }
  const payload: ApiCallPayload = { appSessionId: ap.appSessionId, bridgeId: page.bridgeId, requestId, name, params: forwardedParams, callbacks }
  ap.simulatorWc.send(E.API_CALL, payload)
}

export function handleApiResponse(state: RouterState, sender: WebContents, payload: ApiResponsePayload): void {
  const pending = state.pendingApiCalls.get(payload.requestId)
  if (!pending) return
  const ap = state.appSessions.get(pending.appSessionId)
  if (!ap) {
    state.pendingApiCalls.delete(payload.requestId)
    clearTimeout(pending.timer)
    return
  }
  if (!senderBoundToSession(state, sender, ap)) {
    console.warn('[bridge-router] API_RESPONSE rejected: sender not bound to app session')
    return
  }
  if (payload.ack) {
    clearTimeout(pending.timer)
    pending.timer = undefined
    return
  }
  if ((payload.keep || isPersistentSimulatorApi(pending.name)) && payload.ok) {
    clearTimeout(pending.timer)
    pending.timer = undefined
    sendCallback(ap, pending.callbacks.success, payload.result)
    return
  }
  state.pendingApiCalls.delete(payload.requestId)
  clearTimeout(pending.timer)
  if (payload.ok) {
    sendCallback(ap, pending.callbacks.success, payload.result)
    sendCallback(ap, pending.callbacks.complete, payload.result ?? { errMsg: `${pending.name}:ok` })
    return
  }
  const result = payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)
    ? payload.result as Record<string, unknown> : undefined
  const resultErrMsg = typeof result?.errMsg === 'string' ? result.errMsg : undefined
  const fail = { ...result, errMsg: payload.errMsg || resultErrMsg || `${pending.name}:fail` }
  sendCallback(ap, pending.callbacks.fail, fail)
  sendCallback(ap, pending.callbacks.complete, fail)
}
