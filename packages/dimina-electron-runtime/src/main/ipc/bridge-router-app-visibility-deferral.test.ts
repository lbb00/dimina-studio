import { describe, expect, it } from 'vitest'
import { bootRootOnlySession, fireServiceResourceLoaded, minimizeHost, pageShow, restoreHost, toServiceMessages } from './bridge-router-app-lifecycle-test-harness.js'

/**
 * `syncAppVisibility` only delivers appHide/appShow/pageHide/pageShow once the
 * session's service App instance exists (`serviceResourceLoaded`): before that,
 * service `runtime.appHide()/appShow()` silently no-op and are never replayed
 * (dimina/fe/packages/service/src/core/runtime.js). A host hide/show that
 * happens earlier must be delivered once, in WeChat order, when loading
 * catches up — or not at all if the host is already back in the foreground.
 */
describe('syncAppVisibility defers host hide/show until serviceLoaded', () => {
  it('a session spawned while the host is already hidden defers app/page visibility until serviceLoaded, then restores in WeChat order', async () => {
    const first = await bootRootOnlySession()
    minimizeHost(first) // driver's shared state.hostBackgrounded flips true

    const s = await bootRootOnlySession({
      serviceLoaded: false,
      appId: 'app-2',
      existing: { ctx: first.ctx, simulatorWc: first.simulatorWc, mainWindow: first.mainWindow },
    })
    pageShow(s) // UI still reports the new session's root page mounting/showing while hidden

    expect(toServiceMessages(s.serviceWc).some((m) => m.type === 'appHide' || m.type === 'pageHide')).toBe(false)

    fireServiceResourceLoaded(s)

    const afterLoad = toServiceMessages(s.serviceWc).map((m) => m.type)
    const pageHideIndex = afterLoad.indexOf('pageHide')
    const appHideIndex = afterLoad.indexOf('appHide')
    expect(pageHideIndex, 'pageHide must have been sent once serviceLoaded').toBeGreaterThanOrEqual(0)
    expect(appHideIndex, 'appHide must have been sent once serviceLoaded').toBeGreaterThan(pageHideIndex)
    expect((toServiceMessages(s.serviceWc)[pageHideIndex]!.body as { bridgeId: string }).bridgeId).toBe(s.rootBridgeId)
    expect(afterLoad.filter((t) => t === 'pageHide')).toHaveLength(1)
    expect(afterLoad.filter((t) => t === 'appHide')).toHaveLength(1)

    s.serviceWc.send.mockClear()
    restoreHost(s)

    const afterRestore = toServiceMessages(s.serviceWc).map((m) => m.type)
    const appShowIndex = afterRestore.indexOf('appShow')
    const pageShowIndex = afterRestore.indexOf('pageShow')
    expect(appShowIndex, 'appShow must have been sent on restore').toBeGreaterThanOrEqual(0)
    expect(pageShowIndex, 'pageShow must have been sent on restore').toBeGreaterThan(appShowIndex)
    expect((toServiceMessages(s.serviceWc)[pageShowIndex]!.body as { bridgeId: string }).bridgeId).toBe(s.rootBridgeId)
    expect(afterRestore.filter((t) => t === 'appShow')).toHaveLength(1)
    expect(afterRestore.filter((t) => t === 'pageShow')).toHaveLength(1)
  })

  it('a foreground session hidden before serviceLoaded defers delivery, then restores in WeChat order', async () => {
    const s = await bootRootOnlySession({ serviceLoaded: false })
    pageShow(s)

    minimizeHost(s)
    expect(toServiceMessages(s.serviceWc).some((m) => m.type === 'appHide' || m.type === 'pageHide')).toBe(false)

    fireServiceResourceLoaded(s)

    const afterLoad = toServiceMessages(s.serviceWc).map((m) => m.type)
    const pageHideIndex = afterLoad.indexOf('pageHide')
    const appHideIndex = afterLoad.indexOf('appHide')
    expect(pageHideIndex, 'pageHide must have been sent once serviceLoaded').toBeGreaterThanOrEqual(0)
    expect(appHideIndex, 'appHide must have been sent once serviceLoaded').toBeGreaterThan(pageHideIndex)
    expect(afterLoad.filter((t) => t === 'pageHide')).toHaveLength(1)
    expect(afterLoad.filter((t) => t === 'appHide')).toHaveLength(1)

    s.serviceWc.send.mockClear()
    restoreHost(s)

    const afterRestore = toServiceMessages(s.serviceWc).map((m) => m.type)
    const appShowIndex = afterRestore.indexOf('appShow')
    const pageShowIndex = afterRestore.indexOf('pageShow')
    expect(appShowIndex, 'appShow must have been sent on restore').toBeGreaterThanOrEqual(0)
    expect(pageShowIndex, 'pageShow must have been sent on restore').toBeGreaterThan(appShowIndex)
  })

  it('a hide+show that both happen before serviceLoaded sends nothing once serviceLoaded arrives (sent already matches desired)', async () => {
    const s = await bootRootOnlySession({ serviceLoaded: false })
    pageShow(s) // forwards immediately: not gated by serviceLoaded, only by hostHidden
    s.serviceWc.send.mockClear()

    minimizeHost(s)
    restoreHost(s)
    expect(toServiceMessages(s.serviceWc)).toHaveLength(0)

    fireServiceResourceLoaded(s)

    expect(toServiceMessages(s.serviceWc).some((m) => m.type === 'appHide' || m.type === 'appShow' || m.type === 'pageHide' || m.type === 'pageShow')).toBe(false)
  })
})
