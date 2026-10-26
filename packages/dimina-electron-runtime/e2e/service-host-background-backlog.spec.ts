/**
 * E2E (native-host): service-realm API callbacks queued while the app is
 * backgrounded must all be delivered, promptly, once it returns to the
 * foreground — and the service must keep accepting new calls afterward.
 *
 * Background: `BackgroundScheduler` (dimina/fe/packages/service/src/core/
 * background-scheduler.js) pauses on `appHide` and queues non-control
 * messages (`message.js`'s `dispatchBackgroundWork`); `appShow` resumes and
 * drains the backlog one message per host task (`postTask`, a native
 * `setTimeout(fn, 0)` outside a Worker). The service host BrowserWindow is
 * created with `show:false` and never shown (service-host-pool/pool.ts,
 * service-host-window/create.ts) — a plausible place for Chromium's
 * background-tab timer throttling to slow that drain to ~1 message/second.
 *
 * Measured instead (see PR/task notes): a same-page unpatched setTimeout(0)
 * chain in that hidden window shows no throttling versus a visible webContents
 * baseline, and a real 15-30 message backlog drains in under a second total
 * (~25-40ms/message) whether the window was hidden for 500ms or 10s. This
 * spec is the standing guard against that ever regressing, not a fix for a
 * confirmed regression — the timeout below is a generous multiple of the
 * measured baseline, not a target to sleep for.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { evalInWebContentsByUrl, openProject, pollUntil, waitForSimulatorWebview } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

interface AppHandle {
  app: ElectronApplication
  win: PwPage
}

let bootSeq = 0

async function bootApp(): Promise<AppHandle> {
  const appPath = path.resolve(__dirname, 'electron-entry.js')
  const userDataDir = path.resolve(
    process.env.DIMINA_DEVTOOLS_DATA_DIR
      ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'electron-runtime-e2e'),
    'userdata',
    `sh-bg-backlog-${process.pid}-${bootSeq++}`,
  )
  fs.mkdirSync(userDataDir, { recursive: true })

  const app = await _electron.launch({
    args: [appPath, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'test', DIMINA_E2E_USER_DATA_DIR: userDataDir },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // Mirrors native-host-websocket-policy.spec.ts: park the main window
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

const JS_INSTALL_LIFECYCLE = `(() => {
  var g = globalThis;
  g.__bgLifecycle = { hide: 0, show: 0 };
  if (typeof wx.onAppHide === 'function') wx.onAppHide(function () { g.__bgLifecycle.hide += 1; });
  if (typeof wx.onAppShow === 'function') wx.onAppShow(function () { g.__bgLifecycle.show += 1; });
  return true;
})()`

async function readLifecycle(app: ElectronApplication): Promise<{ hide: number; show: number }> {
  return evalService(app, `globalThis.__bgLifecycle`)
}

// Wraps both sides of `DiminaServiceBridge`: `invoke` (the outbound method
// service-host preload.cjs installs) to capture the callback id each fired
// 'setNavigationBarTitle' call sends out (invokeAPI's body is `{ name, bridgeId,
// params }`, dimina/fe packages/service/src/api/common/index.js's invokeMessage;
// params.success is that call's disposable callback id, dimina/fe .../callback.js),
// and `onMessage` (the getter/setter backed by service-message-queue.cjs) to record
// when each of THOSE ids' reply reaches the paused service — main sends replies as
// `{ type: 'triggerCallback', body: { id, args } }` (bridge-router-callbacks.ts's
// sendCallback, using the same id it read back off invokeAPI's params.success in
// bridge-router-api-navigation.ts). Tracking by id instead of counting every
// 'triggerCallback' matters: unrelated replies in flight also arrive with that type
// and could otherwise satisfy a generic count before this test's own 12 calls have
// actually arrived.
const JS_INSTALL_ID_TRACKING = `(() => {
  var g = globalThis;
  g.__bgCapturedIds = new Set();
  g.__bgArrivedIds = new Set();
  var originalInvoke = DiminaServiceBridge.invoke;
  g.__bgOriginalInvoke = originalInvoke;
  DiminaServiceBridge.invoke = function (msg) {
    if (msg && msg.type === 'invokeAPI' && msg.body && msg.body.name === 'setNavigationBarTitle') {
      var id = msg.body.params && msg.body.params.success;
      if (id !== undefined && id !== null && id !== '') g.__bgCapturedIds.add(id);
    }
    return originalInvoke(msg);
  };
  var originalOnMessage = DiminaServiceBridge.onMessage;
  g.__bgMsgOriginalHandler = originalOnMessage;
  DiminaServiceBridge.onMessage = function (msg) {
    if (msg && msg.type === 'triggerCallback' && msg.body && g.__bgCapturedIds.has(msg.body.id)) {
      g.__bgArrivedIds.add(msg.body.id);
    }
    return originalOnMessage(msg);
  };
  return true;
})()`

async function resetIdTracking(app: ElectronApplication): Promise<void> {
  await evalService(app, `(globalThis.__bgCapturedIds = new Set(), globalThis.__bgArrivedIds = new Set(), true)`)
}

async function capturedIdCount(app: ElectronApplication): Promise<number> {
  return evalService<number>(app, `globalThis.__bgCapturedIds ? globalThis.__bgCapturedIds.size : 0`)
}

async function arrivedIdCount(app: ElectronApplication): Promise<number> {
  return evalService<number>(app, `globalThis.__bgArrivedIds ? globalThis.__bgArrivedIds.size : 0`)
}

async function restoreIdTracking(app: ElectronApplication): Promise<void> {
  await evalService(app, `(() => {
    if (globalThis.__bgOriginalInvoke) DiminaServiceBridge.invoke = globalThis.__bgOriginalInvoke;
    if (globalThis.__bgMsgOriginalHandler) DiminaServiceBridge.onMessage = globalThis.__bgMsgOriginalHandler;
    return true;
  })()`)
}

async function expectHidden(app: ElectronApplication, baseHide: number): Promise<void> {
  expect(
    await pollUntil(async () => (await readLifecycle(app)).hide > baseHide, (v) => v, 5_000, 100),
    'minimize must drive appHide',
  ).toBe(true)
}

async function expectShown(app: ElectronApplication, baseShow: number): Promise<void> {
  expect(
    await pollUntil(async () => (await readLifecycle(app)).show > baseShow, (v) => v, 5_000, 100),
    'restore must drive appShow',
  ).toBe(true)
}

/** Fires N setNavigationBarTitle calls; each success callback pushes a timestamp into `arrayName`. */
function jsFireBacklog(arrayName: string, n: number, prefix: string): string {
  return `(() => {
    globalThis[${JSON.stringify(arrayName)}] = [];
    for (let i = 0; i < ${n}; i++) {
      wx.setNavigationBarTitle({
        title: ${JSON.stringify(prefix)} + i,
        success: () => globalThis[${JSON.stringify(arrayName)}].push(performance.now()),
      });
    }
    return true;
  })()`
}

async function backlogLength(app: ElectronApplication, arrayName: string): Promise<number> {
  return evalService<number>(app, `(globalThis[${JSON.stringify(arrayName)}] || []).length`)
}

test.describe('service host background-scheduler message backlog', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  let handle: AppHandle | undefined

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    handle = await bootApp()
    await evalService(handle.app, JS_INSTALL_LIFECYCLE)
    await evalService(handle.app, JS_INSTALL_ID_TRACKING)
  })

  test.afterAll(async () => {
    await shutdownApp(handle)
  })

  test('delivers every queued callback after returning to the foreground, and stays responsive to a new call', async () => {
    const app = handle!.app
    const backlogKey = '__bgBacklogMain'
    const BACKLOG_SIZE = 12

    const base = await readLifecycle(app)
    await setMainWindowBackgrounded(app, true)
    await expectHidden(app, base.hide)

    await resetIdTracking(app)
    await evalService(app, jsFireBacklog(backlogKey, BACKLOG_SIZE, 'bg-'))
    expect(
      await capturedIdCount(app),
      'each fired call must produce exactly one captured outbound callback id',
    ).toBe(BACKLOG_SIZE)
    // Deterministic confirmation that all BACKLOG_SIZE queued replies — identified
    // by the callback ids captured above, not just message type — actually arrived
    // at (and were queued by) the paused service, before asserting none leaked
    // through early. This is not a wait for the drain itself, which only starts on
    // restore below.
    await expect
      .poll(() => arrivedIdCount(app), { timeout: 5_000, intervals: [50] })
      .toBe(BACKLOG_SIZE)
    expect(
      await backlogLength(app, backlogKey),
      'no callback may be delivered while the app is backgrounded',
    ).toBe(0)
    await restoreIdTracking(app)

    await setMainWindowBackgrounded(app, false)
    await expectShown(app, base.show)

    // Baseline: 15-30 queued messages drain in 600-750ms total after restore
    // (measured directly against this window, both after a 500ms and a 10s
    // hide). 3s is ~5x that measured worst case — generous for CI load — yet
    // still far under the ~12s a real regression to ~1 message/second
    // throttling would take for this backlog size, so this stays a real guard
    // against that regression rather than a bound wide enough to hide it.
    await expect
      .poll(() => backlogLength(app, backlogKey), { timeout: 3_000, intervals: [100] })
      .toBe(BACKLOG_SIZE)

    // Second interaction: a fresh call made after the backlog has fully
    // drained must still get a prompt, correct callback — the drain loop
    // must leave the scheduler in a normal (unpaused, non-draining) state.
    const second = await evalService<{ ok: boolean; title: string }>(
      app,
      `new Promise((resolve) => {
        wx.setNavigationBarTitle({
          title: 'after-restore',
          success: () => resolve({ ok: true, title: 'after-restore' }),
          fail: () => resolve({ ok: false, title: 'after-restore' }),
        });
      })`,
    )
    expect(second).toEqual({ ok: true, title: 'after-restore' })
  })
})
