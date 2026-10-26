/**
 * E2E (native-host): minimizing/restoring the main window must drive
 * page-level lifecycle alongside app-level lifecycle, in WeChat's documented
 * order (dimina/docs/MiniProgram-Retention.md; web container
 * jscore.ts:110-163, miniApp.ts:1076-1085): a hide is Page.onHide → App.onHide,
 * a show is App.onShow → Page.onShow. App-level events alone are not enough:
 * each minimize→restore cycle must also reach the visible page.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { evalInWebContentsById, evalInWebContentsByUrl, ipcInvoke, ipcSend, openProject, pollUntil, waitForSimulatorWebview } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')
const SPAWN_FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'host-bg-spawn-bundle')

interface AppHandle {
  app: ElectronApplication
  win: PwPage
}

interface SpawnResult {
  appSessionId: string
  bridgeId: string
  serviceWcId: number
}

let bootSeq = 0

async function bootApp(): Promise<AppHandle> {
  const appPath = path.resolve(__dirname, 'electron-entry.js')
  const userDataDir = path.resolve(
    process.env.DIMINA_DEVTOOLS_DATA_DIR
      ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'electron-runtime-e2e'),
    'userdata',
    `host-page-lifecycle-${process.pid}-${bootSeq++}`,
  )
  fs.mkdirSync(userDataDir, { recursive: true })

  const app = await _electron.launch({
    args: [appPath, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'test', DIMINA_E2E_USER_DATA_DIR: userDataDir },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // Mirrors service-host-background-backlog.spec.ts: park the main window
  // off-screen so minimize/restore doesn't fight a real display, and record
  // its id since a fresh window can otherwise fail BrowserWindow identity
  // checks across the CDP boundary.
  await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.isVisible()) {
      await new Promise<void>((resolve) => {
        window.once('show', resolve)
        setTimeout(resolve, 5000)
      })
    }
    if (window) {
      ;(globalThis as { __e2eMainWindowId?: number }).__e2eMainWindowId = window.id
      window.setPosition(-2000, -2000)
      window.blur()
    }
  })

  await openProject(app, FIXTURE_DIR)
  await waitForSimulatorWebview(app)
  await pollUntil(
    () => evalInWebContentsByUrl<boolean>(app, 'service.html', `typeof wx !== 'undefined' && typeof wx.setNavigationBarTitle === 'function'`).catch(() => false),
    (ready) => ready === true,
    20_000,
    500,
  )
  return { app, win }
}

async function shutdownApp(handle: AppHandle | undefined): Promise<void> {
  if (!handle) return
  await handle.app.close().catch(() => {})
}

async function evalService<T>(app: ElectronApplication, expression: string): Promise<T> {
  return evalInWebContentsByUrl<T>(app, 'service.html', expression)
}

async function setMainWindowBackgrounded(app: ElectronApplication, backgrounded: boolean): Promise<void> {
  await app.evaluate(({ BrowserWindow }, flag) => {
    const id = (globalThis as { __e2eMainWindowId?: number }).__e2eMainWindowId
    const window = BrowserWindow.getAllWindows().find((w) => w.id === id)
    if (!window) throw new Error('main window not found')
    if (flag) window.minimize()
    else window.restore()
  }, backgrounded)
}

// `getCurrentPages`/`getApp` are only registered once the app's router has
// actually booted (dimina/fe/packages/service/src/core/env.js) — calling
// either before that throws, so callers must poll this before installing any
// hook that reads them.
const JS_APP_READY = `typeof getApp === 'function' && !!getApp() && typeof getCurrentPages === 'function' && getCurrentPages().length > 0`

async function waitAppReady(app: ElectronApplication): Promise<void> {
  await pollUntil(
    () => evalService<boolean>(app, JS_APP_READY).catch(() => false),
    (ready) => ready === true,
    20_000,
    300,
  )
}

// Overrides the root page's onShow/onHide and registers wx.onAppShow/onAppHide,
// recording every firing (in order) into `globalThis.__lcSeq`. `invokeSafely`
// (dimina/fe/packages/service/src/instance/page/page.js) reads `this.onShow` /
// `this.onHide` dynamically at dispatch time, not at construction — so
// assigning these after the page is already running still takes effect on the
// next pageShow/pageHide.
//
// Also wraps `globalThis.Page` so any page module registered AFTER this point
// (i.e. any page navigated to for the first time later in the test) gets its
// onShow/onHide instrumented too — at the shared module-definition level, not
// on a live instance. This matters because `runtime.createInstance`
// (dimina/fe/packages/service/src/core/runtime.js) can call `pageShow()`
// synchronously in the very same tick that `router.push` makes the page
// visible via `getCurrentPages()`, whenever the page's `pendingShow` state was
// already set before the instance existed. Polling `getCurrentPages()` and
// patching the instance afterward can therefore miss the page's first onShow
// entirely; patching the module's `moduleInfo` before any instance is built
// avoids that race because `Page#init` binds `this.onShow`/`this.onHide` from
// `moduleInfo` before invoking either.
const JS_INSTALL_LIFECYCLE = `(() => {
  var g = globalThis;
  g.__lcSeq = [];
  var root = getCurrentPages()[0];
  root.onShow = function () { g.__lcSeq.push('Page.onShow'); };
  root.onHide = function () { g.__lcSeq.push('Page.onHide'); };
  wx.onAppShow(function () { g.__lcSeq.push('App.onShow'); });
  wx.onAppHide(function () { g.__lcSeq.push('App.onHide'); });

  var origPage = g.Page;
  g.Page = function (moduleInfo) {
    var origShow = moduleInfo.onShow;
    moduleInfo.onShow = function () {
      g.__lcSeq.push('Page.onShow:' + this.route);
      if (origShow) origShow.apply(this, arguments);
    };
    var origHide = moduleInfo.onHide;
    moduleInfo.onHide = function () {
      g.__lcSeq.push('Page.onHide:' + this.route);
      if (origHide) origHide.apply(this, arguments);
    };
    return origPage(moduleInfo);
  };
  return true;
})()`

async function readSeq(app: ElectronApplication): Promise<string[]> {
  return evalService<string[]>(app, 'globalThis.__lcSeq || []')
}

function countOf(seq: string[], label: string): number {
  return seq.filter((s) => s === label).length
}

test.describe('host minimize/restore drives Page.onHide/onShow alongside App.onHide/onShow', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  let handle: AppHandle | undefined

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    handle = await bootApp()
    await waitAppReady(handle.app)
    await evalService(handle.app, JS_INSTALL_LIFECYCLE)
  })

  test.afterAll(async () => {
    await shutdownApp(handle)
  })

  test('minimize fires Page.onHide before App.onHide; restore fires App.onShow before Page.onShow', async () => {
    const app = handle!.app

    await setMainWindowBackgrounded(app, true)
    await expect
      .poll(() => readSeq(app), { timeout: 5_000, intervals: [100] })
      .toEqual(['Page.onHide', 'App.onHide'])

    await setMainWindowBackgrounded(app, false)
    await expect
      .poll(() => readSeq(app), { timeout: 5_000, intervals: [100] })
      .toEqual(['Page.onHide', 'App.onHide', 'App.onShow', 'Page.onShow'])
  })

  test('a second hide/show round repeats the same order and brings every count to 2', async () => {
    const app = handle!.app

    await setMainWindowBackgrounded(app, true)
    await expect.poll(async () => countOf(await readSeq(app), 'App.onHide'), { timeout: 5_000, intervals: [100] }).toBe(2)
    await expect.poll(async () => countOf(await readSeq(app), 'Page.onHide'), { timeout: 5_000, intervals: [100] }).toBe(2)

    await setMainWindowBackgrounded(app, false)
    await expect.poll(async () => countOf(await readSeq(app), 'App.onShow'), { timeout: 5_000, intervals: [100] }).toBe(2)
    await expect.poll(async () => countOf(await readSeq(app), 'Page.onShow'), { timeout: 5_000, intervals: [100] }).toBe(2)

    expect(await readSeq(app)).toEqual([
      'Page.onHide', 'App.onHide', 'App.onShow', 'Page.onShow',
      'Page.onHide', 'App.onHide', 'App.onShow', 'Page.onShow',
    ])
  })

  test('a second interaction after restore: navigating to a new page shows it and hides the previous one', async () => {
    const app = handle!.app
    const before = await readSeq(app)

    await evalService(app, `wx.navigateTo({ url: '/pages/detail/detail' })`)

    // The module-level hook installed in beforeAll records this the instant
    // the new page's onShow fires, however early that lands relative to this
    // poll — no live-instance patch race to lose here (see JS_INSTALL_LIFECYCLE).
    await expect
      .poll(
        async () => (await readSeq(app)).includes('Page.onShow:pages/detail/detail'),
        { timeout: 10_000, intervals: [200] },
      )
      .toBe(true)

    const added = (await readSeq(app)).slice(before.length)
    expect(added, 'the previous (home) page must hide on navigateTo').toContain('Page.onHide')
  })

  // `syncAppVisibility` (bridge-router-api-navigation.ts) withholds a session's
  // appHide/pageHide until the service's App instance is constructed
  // (`ap.serviceLoaded`). A session spawned while the host is ALREADY
  // backgrounded starts with `hostHidden` snapshotted true at spawn
  // (bridge-router-spawn.ts), so it never gets a real Page.onShow while hidden —
  // `handlePageLifecycle` (bridge-router-pages.ts) only bookkeeps
  // `visibleBridgeId` without forwarding while `ap.hostHidden`. This dedicated
  // fixture registers its lifecycle recorder inside the App's own `onLaunch`
  // (construction-time, before the container's `serviceResourceLoaded` message
  // that gates `syncAppVisibility`) so it observes the deferred appHide even
  // though it fires before any test-side script could attach a listener.
  //
  // Reuses this describe's already-booted `handle` (rather than launching a
  // second Electron instance) — a second `bootApp()` here pushed the shared
  // e2e worker past its teardown budget and made an unrelated later spec
  // (service-host-background-backlog.spec.ts) time out in `afterAll`.
  test('spawning a session while the host is already backgrounded never observes Page.onShow while hidden; App.onHide fires; restore re-fires App.onShow', async () => {
    const app = handle!.app
    const win = handle!.win

    await setMainWindowBackgrounded(app, true)

    const spawned = await ipcInvoke<SpawnResult>(win, 'dmb:spawn', {
      appId: `host-bg-spawn-${process.pid}`,
      pagePath: 'pages/index/index',
      pkgRoot: SPAWN_FIXTURE_DIR,
      root: 'main',
    })

    await pollUntil(
      () => evalInWebContentsById<boolean>(app, spawned.serviceWcId, 'typeof globalThis.__lcSeq !== "undefined"').catch(() => false),
      (ready) => ready === true,
      20_000,
      300,
    )

    await expect
      .poll(
        () => evalInWebContentsById<string[]>(app, spawned.serviceWcId, 'globalThis.__lcSeq || []'),
        { timeout: 10_000, intervals: [200] },
      )
      .toContain('App.onHide')

    // The App's own construction-time onShow (mirrors dimina's App.onLaunch →
    // App.onShow) fires and IS observed — `wx.onAppShow` was registered inside
    // `onLaunch` itself, synchronously before that baseline show dispatches.
    // `syncAppVisibility` then corrects it back to hidden with the deferred
    // appHide once `serviceLoaded` flips true.
    const whileHidden = await evalInWebContentsById<string[]>(app, spawned.serviceWcId, 'globalThis.__lcSeq || []')
    expect(whileHidden, 'a page mounted while the host is backgrounded must never observe a real Page.onShow').not.toContain('Page.onShow')
    expect(whileHidden).toEqual(['App.onShow', 'App.onHide'])

    await setMainWindowBackgrounded(app, false)

    // Page-level: `syncAppVisibility`'s deferred pageShow only fires when
    // `ap.visibleBridgeId` is set, which requires a real render-side pageShow
    // round trip through `handlePageLifecycle` (bridge-router-pages.ts) — the
    // headless `dmb:spawn` path used here (no simulator UI / render webview,
    // same as launch-options.spec.ts) never produces that round trip, so
    // `visibleBridgeId` stays null and there is nothing for this scenario to
    // defer at the page level. The app-level ordering below (and the page-level
    // pairing once `visibleBridgeId` IS set) is exhaustively covered by the
    // three `syncAppVisibility` unit tests in bridge-router-app-lifecycle.test.ts.
    await expect
      .poll(
        () => evalInWebContentsById<string[]>(app, spawned.serviceWcId, 'globalThis.__lcSeq || []'),
        { timeout: 10_000, intervals: [200] },
      )
      .toEqual(['App.onShow', 'App.onHide', 'App.onShow'])

    // `dmb:dispose` (bridge-router-ipc-install.ts) is a one-way `send`, not an
    // `invoke` — it returns as soon as the message is posted, before the main
    // process's async `disposeAppSession` has actually torn the service host
    // window down. launch-options.spec.ts gets away with the same fire-and-forget
    // call because its Electron process is worker-scoped and only closes much
    // later; here `afterAll` closes the app right after this test, so without
    // waiting for the window to actually go away, that close can race the
    // in-flight dispose and hang (observed as an `afterAll` timeout).
    await ipcSend(win, 'dmb:dispose', { bridgeId: spawned.appSessionId })
    await pollUntil(
      () => app.evaluate(({ webContents }, wcId: number) => {
        const wc = webContents.fromId(wcId)
        return !wc || wc.isDestroyed()
      }, spawned.serviceWcId),
      (gone) => gone === true,
      10_000,
      200,
    )
  })
})
