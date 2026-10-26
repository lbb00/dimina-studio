import { describe, expect, it } from 'vitest'
import { BRIDGE_CHANNELS as C, SIMULATOR_EVENTS as E } from '../../shared/bridge-channels.js'
import type { ApiCallPayload, NavActionPayload } from '../../shared/bridge-channels.js'
import { DETAIL_PAGE, bootReLaunchGapSession, bootRootOnlySession, bootTwoIndependentSessions, bootTwoPageSession, closeRootPage, emitSync, sendsOn, serviceCallbacks, serviceInvokeApi } from './bridge-router-test-harness.js'

describe('service→container messages after the session root page is gone', () => {
  it('still acts on the surviving page and answers the caller', async () => {
    const s = await bootTwoPageSession(); closeRootPage(s)
    serviceInvokeApi(s.serviceWc, { name: 'pageScrollTo', params: { scrollTop: 120, success: 'cb-success', complete: 'cb-complete' } })
    expect(s.detailRenderWc.executeJavaScript).toHaveBeenCalledTimes(1); expect(s.rootRenderWc.executeJavaScript).not.toHaveBeenCalled()
    expect(serviceCallbacks(s.serviceWc)).toEqual([{ id: 'cb-success', args: { errMsg: 'pageScrollTo:ok' } }, { id: 'cb-complete', args: { errMsg: 'pageScrollTo:ok' } }])
  })
  it('still navigates, naming the surviving page as the navigation source', async () => {
    const s = await bootTwoPageSession(); closeRootPage(s); serviceInvokeApi(s.serviceWc, { name: 'navigateTo', params: { url: `/${DETAIL_PAGE}`, success: 'cb-success' } })
    const actions = sendsOn(s.simulatorWc, E.NAV_ACTION) as NavActionPayload[]; expect(actions).toHaveLength(1); expect(actions[0]!.name).toBe('navigateTo'); expect(actions[0]!.bridgeId).toBe(s.detailBridgeId)
  })
  it('completes a simulator-served API round trip back to the service host', async () => {
    const s = await bootTwoPageSession(); closeRootPage(s); serviceInvokeApi(s.serviceWc, { name: 'getSystemInfo', params: { success: 'cb-success', complete: 'cb-complete' } })
    const calls = sendsOn(s.simulatorWc, E.API_CALL) as ApiCallPayload[]; expect(calls).toHaveLength(1); expect(calls[0]!.bridgeId).toBe(s.detailBridgeId)
    emitSync(C.API_RESPONSE, s.simulatorWc, { appSessionId: calls[0]!.appSessionId, requestId: calls[0]!.requestId, ok: true, result: { brand: 'devtools' } })
    expect(serviceCallbacks(s.serviceWc)).toEqual([{ id: 'cb-success', args: { brand: 'devtools' } }, { id: 'cb-complete', args: { brand: 'devtools' } }])
  })
})

const scroll = { scrollTop: 40, success: 'cb-success', complete: 'cb-complete' }
const callbacks = [{ id: 'cb-success', args: { errMsg: 'pageScrollTo:ok' } }, { id: 'cb-complete', args: { errMsg: 'pageScrollTo:ok' } }]
describe('service→container routing: named page vs. reported stack top', () => {
  it('routes to the named page even when another page is reported top', async () => { const s = await bootTwoPageSession(); serviceInvokeApi(s.serviceWc, { bridgeId: s.rootBridgeId, name: 'pageScrollTo', params: scroll }); expect(s.rootRenderWc.executeJavaScript).toHaveBeenCalledTimes(1); expect(s.detailRenderWc.executeJavaScript).not.toHaveBeenCalled() })
  it('falls back to the reported top when the named page is closed', async () => { const s = await bootTwoPageSession(); closeRootPage(s); serviceInvokeApi(s.serviceWc, { bridgeId: s.rootBridgeId, name: 'pageScrollTo', params: scroll }); expect(s.detailRenderWc.executeJavaScript).toHaveBeenCalledTimes(1); expect(serviceCallbacks(s.serviceWc)).toEqual(callbacks) })
  it('routes an unnamed call to root before ACTIVE_PAGE', async () => { const s = await bootRootOnlySession(); serviceInvokeApi(s.serviceWc, { name: 'pageScrollTo', params: scroll }); expect(s.rootRenderWc.executeJavaScript).toHaveBeenCalledTimes(1); expect(serviceCallbacks(s.serviceWc)).toEqual(callbacks) })
  it('drops an unnamed call in the reLaunch gap', async () => { const s = await bootReLaunchGapSession(); expect(() => serviceInvokeApi(s.serviceWc, { name: 'pageScrollTo', params: scroll })).not.toThrow(); expect(s.rootRenderWc.executeJavaScript).not.toHaveBeenCalled(); expect(s.newRenderWc.executeJavaScript).not.toHaveBeenCalled(); expect(serviceCallbacks(s.serviceWc)).toEqual([]) })
  it('routes a named already-open page in the reLaunch gap', async () => { const s = await bootReLaunchGapSession(); serviceInvokeApi(s.serviceWc, { bridgeId: s.newBridgeId, name: 'pageScrollTo', params: scroll }); expect(s.newRenderWc.executeJavaScript).toHaveBeenCalledTimes(1); expect(serviceCallbacks(s.serviceWc)).toEqual(callbacks) })
  it('does not resolve a bridge in another app session', async () => { const { a, b } = await bootTwoIndependentSessions(); serviceInvokeApi(a.serviceWc, { bridgeId: b.rootBridgeId, name: 'pageScrollTo', params: scroll }); expect(a.rootRenderWc.executeJavaScript).toHaveBeenCalledTimes(1); expect(b.rootRenderWc.executeJavaScript).not.toHaveBeenCalled() })
})
