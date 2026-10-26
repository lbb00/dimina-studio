import { describe, expect, it } from 'vitest'
import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type { PageOpenResult } from '../../shared/bridge-channels.js'
import { DETAIL_PAGE, announceRenderGuest, destroyOwnedGuest, emitSync, install, invokeHandler, makeCtx, makeFakeWc, spawnRoot } from './bridge-router-test-harness.js'

describe('render guest owner loss', () => {
  it('tears down the whole app session when its current render guest is destroyed', async () => {
    const { ctx, simulatorWc } = makeCtx(); const handle = install(ctx); const session = await spawnRoot(simulatorWc, 'app-1')
    expect(handle.census?.()).toMatchObject({ appSessions: 1, pageSessions: 1, serviceWcBindings: 1, simulatorWcBindings: 1, renderWcBindings: 1 })
    destroyOwnedGuest(session.rootRenderWc); await Promise.resolve(); await Promise.resolve()
    expect(handle.census?.()).toMatchObject({ appSessions: 0, pageSessions: 0, serviceWcBindings: 0, simulatorWcBindings: 0, renderWcBindings: 0, pendingApiCalls: 0 })
  })
  it('does not dispose a session for a superseded or PAGE_CLOSE render guest', async () => {
    const { ctx, simulatorWc } = makeCtx(); const handle = install(ctx); const root = await spawnRoot(simulatorWc, 'app-1'); const replacement = makeFakeWc()
    announceRenderGuest(replacement, root.rootBridgeId); destroyOwnedGuest(root.rootRenderWc); expect(handle.census?.()).toMatchObject({ appSessions: 1, pageSessions: 1, renderWcBindings: 1 })
    const opened = await invokeHandler(C.PAGE_OPEN, simulatorWc, { appSessionId: root.appSessionId, pagePath: DETAIL_PAGE }) as PageOpenResult
    const detail = makeFakeWc(); announceRenderGuest(detail, opened.bridgeId); emitSync(C.ACTIVE_PAGE, simulatorWc, { appSessionId: root.appSessionId, bridgeId: opened.bridgeId }); emitSync(C.PAGE_CLOSE, simulatorWc, { bridgeId: root.rootBridgeId }); destroyOwnedGuest(replacement)
    expect(handle.census?.()).toMatchObject({ appSessions: 1, pageSessions: 1, renderWcBindings: 1 }); expect(handle.getActiveRenderWc('app-1')).toBe(detail)
  })
})
