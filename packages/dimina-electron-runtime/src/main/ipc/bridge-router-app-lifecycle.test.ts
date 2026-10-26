import { describe, expect, it } from 'vitest'
import { bootRootOnlySession, hideHost, minimizeHost, setBackgroundedSpy, openSecondPage, pageHide, pageShow, pageUnload, restoreHost, showWhileMinimized, toServiceMessages } from './bridge-router-app-lifecycle-test-harness.js'

/**
 * `installAppLifecycleDriver` drives BOTH app- and page-level lifecycle off
 * the main window's minimize/restore. WeChat orders a hide as Page.onHide →
 * App.onHide and a show as App.onShow → Page.onShow (dimina/docs/
 * MiniProgram-Retention.md); `hide`/`minimize` (and `restore`/`show`) can
 * each fire for the same foreground↔background edge and must collapse into
 * one signal. While the host is backgrounded, a page mounting/unmounting in
 * the UI is not a real WeChat show/hide — only `AppSession.hostHidden`
 * flipping back on restore may forward the deferred pageShow. This suite
 * pins all of that as an observable `TO_SERVICE` contract.
 */
describe('installAppLifecycleDriver — host hide/show orders page- and app-level lifecycle', () => {
  it('hides page-then-app: pageHide(visible) before appHide', () => {
    return (async () => {
      const s = await bootRootOnlySession()
      pageShow(s)

      minimizeHost(s)

      const types = toServiceMessages(s.serviceWc).map((m) => m.type)
      const hideIndex = types.indexOf('pageHide')
      const appHideIndex = types.indexOf('appHide')
      expect(hideIndex, 'pageHide must have been sent').toBeGreaterThanOrEqual(0)
      expect(appHideIndex, 'appHide must have been sent').toBeGreaterThan(hideIndex)
      const hideBody = toServiceMessages(s.serviceWc)[hideIndex]!.body as { bridgeId: string }
      expect(hideBody.bridgeId).toBe(s.rootBridgeId)
    })()
  })

  it('sends only appHide when no page is currently visible', async () => {
    const s = await bootRootOnlySession()
    // No pageShow yet — visibleBridgeId is still null.

    minimizeHost(s)

    const types = toServiceMessages(s.serviceWc).map((m) => m.type)
    expect(types).not.toContain('pageHide')
    expect(types).toContain('appHide')
  })

  it('shows app-then-page: appShow before pageShow(visible)', async () => {
    const s = await bootRootOnlySession()
    pageShow(s)
    minimizeHost(s)
    s.serviceWc.send.mockClear()

    restoreHost(s)

    const types = toServiceMessages(s.serviceWc).map((m) => m.type)
    const appShowIndex = types.indexOf('appShow')
    const pageShowIndex = types.indexOf('pageShow')
    expect(appShowIndex, 'appShow must have been sent').toBeGreaterThanOrEqual(0)
    expect(pageShowIndex, 'pageShow must have been sent').toBeGreaterThan(appShowIndex)
    const showBody = toServiceMessages(s.serviceWc)[pageShowIndex]!.body as { bridgeId: string }
    expect(showBody.bridgeId).toBe(s.rootBridgeId)
  })

  it('collapses a hide+minimize pair into a single hide signal', async () => {
    const s = await bootRootOnlySession()
    pageShow(s)

    hideHost(s)
    minimizeHost(s)

    const types = toServiceMessages(s.serviceWc).map((m) => m.type)
    expect(types.filter((t) => t === 'appHide')).toHaveLength(1)
    expect(types.filter((t) => t === 'pageHide')).toHaveLength(1)
  })

  it('collapses a restore+show pair into a single show signal', async () => {
    const s = await bootRootOnlySession()
    pageShow(s)
    minimizeHost(s)
    s.serviceWc.send.mockClear()

    restoreHost(s)
    showWhileMinimized(s) // stale extra 'show' after restore already foregrounded

    const types = toServiceMessages(s.serviceWc).map((m) => m.type)
    expect(types.filter((t) => t === 'appShow')).toHaveLength(1)
    expect(types.filter((t) => t === 'pageShow')).toHaveLength(1)
  })

  it('a bare `show` while still minimized does not foreground', async () => {
    const s = await bootRootOnlySession()
    pageShow(s)
    minimizeHost(s)
    s.serviceWc.send.mockClear()

    showWhileMinimized(s)

    const types = toServiceMessages(s.serviceWc).map((m) => m.type)
    expect(types).not.toContain('appShow')
    expect(types).not.toContain('pageShow')
  })

  it('does not forward a UI pageShow for a page mounted while the host is hidden; forwards it once restored', async () => {
    const s = await bootRootOnlySession()
    pageShow(s)
    minimizeHost(s)
    s.serviceWc.send.mockClear()

    const secondBridgeId = await openSecondPage(s)
    pageShow(s, secondBridgeId)

    expect(
      toServiceMessages(s.serviceWc).some((m) => m.type === 'pageShow'),
      'pageShow for a page mounted while backgrounded must not forward yet',
    ).toBe(false)

    restoreHost(s)

    const messages = toServiceMessages(s.serviceWc)
    const pageShows = messages.filter((m) => m.type === 'pageShow')
    expect(pageShows).toHaveLength(1)
    expect((pageShows[0]!.body as { bridgeId: string }).bridgeId).toBe(secondBridgeId)
  })

  it('does not forward a UI pageHide while the host is hidden, but still forwards pageUnload', async () => {
    const s = await bootRootOnlySession()
    pageShow(s)
    minimizeHost(s)
    s.serviceWc.send.mockClear()

    pageHide(s)
    expect(toServiceMessages(s.serviceWc).some((m) => m.type === 'pageHide')).toBe(false)

    pageUnload(s)
    expect(toServiceMessages(s.serviceWc).some((m) => m.type === 'pageUnload')).toBe(true)
  })

  it('counts exactly across two hide/show rounds', async () => {
    const s = await bootRootOnlySession()
    pageShow(s)
    s.serviceWc.send.mockClear()

    minimizeHost(s)
    restoreHost(s)
    minimizeHost(s)
    restoreHost(s)

    const types = toServiceMessages(s.serviceWc).map((m) => m.type)
    expect(types.filter((t) => t === 'appHide')).toHaveLength(2)
    expect(types.filter((t) => t === 'appShow')).toHaveLength(2)
    expect(types.filter((t) => t === 'pageHide')).toHaveLength(2)
    expect(types.filter((t) => t === 'pageShow')).toHaveLength(2)
  })

  it('calls setBackgrounded exactly once per real foreground/background transition', async () => {
    const s = await bootRootOnlySession()
    pageShow(s)
    setBackgroundedSpy.mockClear()

    hideHost(s)
    minimizeHost(s)
    expect(setBackgroundedSpy).toHaveBeenCalledTimes(1)
    expect(setBackgroundedSpy).toHaveBeenLastCalledWith(true)

    restoreHost(s)
    showWhileMinimized(s)
    expect(setBackgroundedSpy).toHaveBeenCalledTimes(2)
    expect(setBackgroundedSpy).toHaveBeenLastCalledWith(false)
  })
})
