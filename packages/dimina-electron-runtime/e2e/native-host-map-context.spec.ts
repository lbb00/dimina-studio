/**
 * E2E (native-host only): the Web `<map>` component reads its provider
 * config from `globalThis.__DIMINA_MAP_CONFIG__` on the render-host guest
 * (dimina/fe/packages/components/src/component/map/map-session.js). Studio's
 * render-host preload must inject this object so the component can (a) show
 * an actionable "no key configured" hint instead of the generic "provider not
 * configured" one, and (b) resolve a registered provider and route
 * `wx.createMapContext(...).invoke(...)` through it via `map-context.js`.
 *
 * Three scenarios, run serially against one project session:
 *   A) No credentials configured → the component's error hint must say
 *      "未配置地图 Key" (Map.vue's errorHint regex only matches this string
 *      when `authorize()` throws a message containing
 *      'AMap Web key is required' — the OTHER hint, "地图未配置，请配置地图
 *      Key 和服务提供方", fires only when `config` itself is `undefined`, i.e.
 *      when render-host never injects `__DIMINA_MAP_CONFIG__` at all).
 *   B) Registering a fake provider on the injected config and remounting the
 *      component must let it create successfully and answer
 *      `wx.createMapContext('m').getScale(...)` with the fake provider's
 *      result — proving the whole render→service round trip
 *      (map-context.js → invokeAPI('mapContext', ..., 'render') →
 *      bridge-router-transport's forwardToRender → Map.vue's
 *      `__diminaMap.invoke`) works end to end.
 *   C) After navigating to a second page, a MapContext constructed on the
 *      FIRST page must still route back to the first page's render-host
 *      (bridge-router-transport routes by the mapContext's own fixed
 *      `mapBridgeId`, not by "the active page" — see
 *      main/ipc/bridge-router-transport.ts forwardToRender). The second page
 *      also has a `<map id="m">` (same id), whose render-host gets an
 *      unpatched config from the env, so its authorize() throws: if routing
 *      ever misdirected to the active page instead of the fixed bridge id,
 *      getScale would fail against that unauthorized map instead of the
 *      first page's patched one, giving this scenario discriminating power.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  openProject,
  waitForSimulatorWebview,
  closeProject,
  pollUntil,
  evalInWebContentsByUrl,
  getCurrentPage,
  callWxMethod,
} from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'map-app')

const INDEX_URL_MARKER = '/pages/index/'
const SECOND_URL_MARKER = '/pages/second/'
const SERVICE_URL_MARKER = 'service.html'

let electronApp: ElectronApplication
let mainWindow: PwPage

async function mapErrorText(): Promise<string | null> {
  return evalInWebContentsByUrl<string | null>(
    electronApp,
    INDEX_URL_MARKER,
    `(() => {
      const el = document.querySelector('.dd-map-error')
      return el ? el.textContent.trim() : null
    })()`,
  )
}

async function clickToggleMap(): Promise<void> {
  await evalInWebContentsByUrl<boolean>(
    electronApp,
    INDEX_URL_MARKER,
    `(() => {
      const el = document.querySelector('[data-action="toggle-map"]')
      if (el && typeof el.click === 'function') { el.click(); return true }
      return false
    })()`,
  )
}

test.describe('native-host map component provider config', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'electron-runtime-e2e'),
      'userdata',
      `nh-map-context-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    // Explicitly unset any map credentials the dev machine's shell might
    // already export, so scenario A's "no config" assertion is deterministic
    // regardless of the environment this test runs in.
    const env = { ...process.env, NODE_ENV: 'test', DIMINA_E2E_USER_DATA_DIR: userDataDir }
    delete env.DIMINA_AMAP_WEB_KEY
    delete env.DIMINA_AMAP_SECURITY_JS_CODE
    delete env.DIMINA_AMAP_SERVICE_HOST
    delete env.DIMINA_AMAP_PRIVACY_CONSENT

    electronApp = await _electron.launch({
      args: [appPath, `--user-data-dir=${userDataDir}`],
      env,
    })

    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')

    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isVisible()) {
        await new Promise<void>((resolve) => {
          win.once('show', resolve)
          setTimeout(resolve, 5000)
        })
      }
      if (win) {
        win.setPosition(-2000, -2000)
        win.blur()
      }
    })

    await openProject(electronApp, FIXTURE_DIR)
    await waitForSimulatorWebview(electronApp)

    await pollUntil(
      () => evalInWebContentsByUrl<boolean>(
        electronApp,
        INDEX_URL_MARKER,
        `(() => !!document.querySelector('.dd-map'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      25000,
      300,
    )
  })

  test.afterAll(async () => {
    await closeProject(electronApp).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('A: no map credentials configured shows the "未配置地图 Key" hint', async () => {
    const text = await pollUntil(
      () => mapErrorText().catch(() => null),
      (t) => t !== null,
      20000,
      300,
    )
    expect(text).toContain('未配置地图 Key')
  })

  test('B: a registered provider mounts and answers wx.createMapContext getScale', async () => {
    // Unmount the map so the next mount re-reads the (about to be patched)
    // window.__DIMINA_MAP_CONFIG__ from scratch.
    await clickToggleMap()
    await pollUntil(
      () => evalInWebContentsByUrl<boolean>(
        electronApp,
        INDEX_URL_MARKER,
        `(() => !document.querySelector('.dd-map'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      10000,
      200,
    )

    // Patch the EXISTING injected config object (not a wholesale replacement)
    // so this step fails loudly, before the fix, on the real symptom: the
    // studio render-host never injects __DIMINA_MAP_CONFIG__ at all.
    await evalInWebContentsByUrl<boolean>(
      electronApp,
      INDEX_URL_MARKER,
      `(() => {
        const cfg = window.__DIMINA_MAP_CONFIG__
        if (!cfg || !cfg.providers) throw new Error('__DIMINA_MAP_CONFIG__ not injected')
        cfg.providers.amap = {
          create: async () => ({
            update: async () => {},
            invoke: async (command) => command === 'getScale' ? { scale: 12.34, e2e: true } : {},
            destroy: () => {},
          }),
        }
        cfg.authorize = () => true
        return true
      })()`,
    )

    await clickToggleMap()
    await pollUntil(
      () => mapErrorText().catch(() => 'pending'),
      (t) => t === null,
      20000,
      300,
    )

    const result = await evalInWebContentsByUrl<{ ok: boolean, res?: { scale: number, e2e: boolean }, err?: string }>(
      electronApp,
      SERVICE_URL_MARKER,
      `(() => new Promise((resolve) => {
        window.__e2eMapCtx = wx.createMapContext('m')
        window.__e2eMapCtx.getScale({
          success: (res) => resolve({ ok: true, res }),
          fail: (err) => resolve({ ok: false, err: (err && err.errMsg) || String(err) }),
        })
      }))()`,
    )

    expect(result.ok, `getScale should succeed, got ${JSON.stringify(result)}`).toBe(true)
    expect(result.res?.scale).toBe(12.34)
    expect(result.res?.e2e).toBe(true)
  })

  test('C: a MapContext created on the first page still routes there after navigating away', async () => {
    await callWxMethod(electronApp, 'navigateTo', [{ url: '/pages/second/second' }])

    const cur = await pollUntil(
      () => getCurrentPage(electronApp).catch(() => null),
      (r) => !!r && typeof r.path === 'string' && r.path.includes('pages/second/second'),
      15000,
      300,
    )
    expect(cur?.path).toContain('pages/second/second')

    // The second page's own <map id="m"> must have mounted before asserting
    // routing: without this, a misroute to the active page could fail simply
    // because there's nothing there yet, which would not distinguish a
    // routing bug from a timing fluke.
    await pollUntil(
      () => evalInWebContentsByUrl<boolean>(
        electronApp,
        SECOND_URL_MARKER,
        `(() => !!document.querySelector('.dd-map'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      15000,
      300,
    )

    const result = await evalInWebContentsByUrl<{ ok: boolean, res?: { scale: number }, err?: string }>(
      electronApp,
      SERVICE_URL_MARKER,
      `(() => new Promise((resolve) => {
        window.__e2eMapCtx.getScale({
          success: (res) => resolve({ ok: true, res }),
          fail: (err) => resolve({ ok: false, err: (err && err.errMsg) || String(err) }),
        })
      }))()`,
    )

    expect(result.ok, `getScale on the stale first-page MapContext should still succeed, got ${JSON.stringify(result)}`).toBe(true)
    expect(result.res?.scale).toBe(12.34)
  })
})
