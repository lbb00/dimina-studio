import { describe, expect, it, vi } from 'vitest'
import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type { MessageEnvelope, PageOpenResult } from '../../shared/bridge-channels.js'
import { DETAIL_PAGE, announceRenderGuest, bootRootOnlySession, emitSync, invokeHandler, makeFakeWc, sendsOn } from './bridge-router-test-harness.js'

/**
 * Upstream's service handler (dimina/fe packages/service/src/index.js) reads
 * `scene`/`query`/`referrerInfo` off `loadResource` and feeds them to
 * `runtime.setAppLaunchOptions`, which backs both `wx.getLaunchOptionsSync()`
 * and `wx.getEnterOptionsSync()`. That setter only takes effect before the
 * `App` instance exists (core/runtime.js), i.e. only for the very first
 * `loadResource` a session's service host receives — the one `bootServiceHost`
 * sends for the ROOT page. Every other `loadResource` (non-root pages, and
 * the render target) is a no-op for launch options upstream, so this suite
 * pins the fields to exactly that one send.
 */
function serviceLoadResourceBodies(wc: Parameters<typeof sendsOn>[0]): Record<string, unknown>[] {
  return sendsOn(wc, C.TO_SERVICE)
    .map(v => (v as { msg: MessageEnvelope }).msg)
    .filter(msg => msg.type === 'loadResource')
    .map(msg => msg.body)
}

function renderLoadResourceBodies(wc: Parameters<typeof sendsOn>[0]): Record<string, unknown>[] {
  return sendsOn(wc, C.TO_RENDER)
    .map(v => (v as { msg: MessageEnvelope }).msg)
    .filter(msg => msg.type === 'loadResource')
    .map(msg => msg.body)
}

/**
 * `bootServiceHost`'s root `loadResource` send trails an async
 * fetch+executeJavaScript chain (`injectLogicBundle`) that the `did-finish-load`
 * firing in `bootRootOnlySession` does not await — mirrors
 * `bridge-router-service-readiness.test.ts`'s `waitForServiceBootSettled`.
 */
async function waitForRootLoadResource(wc: Parameters<typeof sendsOn>[0]): Promise<void> {
  await vi.waitFor(() => {
    if (serviceLoadResourceBodies(wc).length === 0) throw new Error('root loadResource not sent yet')
  })
}

describe('root loadResource carries launch options', () => {
  it('defaults scene to 1001 and carries the (empty) root query + referrerInfo', async () => {
    const s = await bootRootOnlySession()
    await waitForRootLoadResource(s.serviceWc)

    const bodies = serviceLoadResourceBodies(s.serviceWc)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ scene: 1001, query: {}, referrerInfo: {} })
  })

  it('carries the spawn-provided scene and query through to the service host', async () => {
    const s = await bootRootOnlySession('app-1', { scene: 1042, query: { foo: 'bar' } })
    await waitForRootLoadResource(s.serviceWc)

    const bodies = serviceLoadResourceBodies(s.serviceWc)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ scene: 1042, query: { foo: 'bar' }, referrerInfo: {} })
  })

  it('never puts scene/query/referrerInfo on the render-target loadResource', async () => {
    const s = await bootRootOnlySession('app-1', { scene: 1042, query: { foo: 'bar' } })
    await waitForRootLoadResource(s.serviceWc)

    const bodies = renderLoadResourceBodies(s.rootRenderWc)
    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) {
      expect(body).not.toHaveProperty('scene')
      expect(body).not.toHaveProperty('query')
      expect(body).not.toHaveProperty('referrerInfo')
    }
  })

  it('never puts scene/query/referrerInfo on a non-root page\'s service loadResource', async () => {
    const s = await bootRootOnlySession('app-1', { scene: 1042, query: { foo: 'bar' } })
    await waitForRootLoadResource(s.serviceWc)

    const opened = (await invokeHandler(C.PAGE_OPEN, s.simulatorWc, {
      appSessionId: s.appSessionId,
      pagePath: DETAIL_PAGE,
      query: { id: '42' },
    })) as PageOpenResult
    const detailRenderWc = makeFakeWc()
    announceRenderGuest(detailRenderWc, opened.bridgeId)

    // Drive both halves of `maybeSendResourceLoaded`'s gate so the detail
    // page's own service-side loadResource actually gets sent.
    emitSync(C.SERVICE_INVOKE, s.serviceWc, { msg: { type: 'serviceResourceLoaded', target: 'container', body: {} } })
    emitSync(C.RENDER_INVOKE, detailRenderWc, {
      bridgeId: opened.bridgeId,
      msg: { type: 'renderResourceLoaded', target: 'container', body: { bridgeId: opened.bridgeId } },
    })

    const bodies = serviceLoadResourceBodies(s.serviceWc)
    const detailLoad = bodies.find(b => b.bridgeId === opened.bridgeId)
    expect(detailLoad, 'the detail page must still get its own service loadResource').toBeDefined()
    expect(detailLoad).not.toHaveProperty('scene')
    expect(detailLoad).not.toHaveProperty('query')
    expect(detailLoad).not.toHaveProperty('referrerInfo')
  })
})
