import path from 'path'
import { fileURLToPath } from 'url'
import type { ElectronApplication } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  evalInWebContentsByUrl,
  ipcInvoke,
  ipcSend,
  pollUntil,
} from './helpers'

/**
 * Guards the fix for scene/query/referrerInfo missing from a launched app's
 * options: upstream's service (dimina/fe packages/service/src/index.js) only
 * applies these off the ROOT page's `loadResource`, so `wx.getLaunchOptionsSync()`,
 * `wx.getEnterOptionsSync()`, and the fixture app's own `App.onLaunch` argument
 * must all agree with what was passed to `dmb:spawn`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_BUNDLE = path.resolve(__dirname, 'fixtures', 'native-host-bundle')

interface SpawnResult {
  appSessionId: string
  bridgeId: string
}

async function evalInServiceHost<T = unknown>(electronApp: ElectronApplication, expression: string): Promise<T> {
  return evalInWebContentsByUrl<T>(electronApp, '/service-host/service.html', expression)
}

async function waitForServiceHost(electronApp: ElectronApplication): Promise<void> {
  await pollUntil(
    async () =>
      electronApp.evaluate(({ webContents }) =>
        webContents.getAllWebContents().some((wc) =>
          !wc.isDestroyed() && wc.getURL().includes('/service-host/service.html'),
        ),
      ),
    (value) => value === true,
    20_000,
    250,
  )
}

async function readLaunchSnapshot(electronApp: ElectronApplication) {
  const sync = await pollUntil(
    () => evalInServiceHost<boolean>(electronApp, 'typeof globalThis.wx?.getLaunchOptionsSync === "function"'),
    (v) => v === true,
    15_000,
    250,
  )
  expect(sync).toBe(true)

  return evalInServiceHost<{
    launch: Record<string, unknown>
    enter: Record<string, unknown>
    onLaunchArg: Record<string, unknown> | undefined
  }>(
    electronApp,
    `({
      launch: wx.getLaunchOptionsSync(),
      enter: wx.getEnterOptionsSync(),
      onLaunchArg: globalThis.__fixtureLaunchOptions,
    })`,
  )
}

test.describe('Launch options', () => {
  test.setTimeout(90_000)
  test.describe.configure({ mode: 'serial' })

  // No shared demo project here (unlike native-host.spec.ts): this spec reads
  // `wx.getLaunchOptionsSync()`/`onLaunch`'s argument off "the" service host by
  // URL substring, so a second, already-open service host (e.g. from a shared
  // demo project) would make that lookup pick the wrong session.

  test('defaults scene to 1001 and carries an empty query/referrerInfo', async ({ mainWindow, electronApp }) => {
    const spawned = await ipcInvoke<SpawnResult>(mainWindow, 'dmb:spawn', {
      appId: 'launch-options-e2e-default',
      pagePath: 'pages/index/index',
      pkgRoot: FIXTURE_BUNDLE,
      root: 'main',
    })
    await waitForServiceHost(electronApp)

    const snapshot = await readLaunchSnapshot(electronApp)
    for (const options of [snapshot.launch, snapshot.enter, snapshot.onLaunchArg]) {
      expect(options).toMatchObject({ path: 'pages/index/index', scene: 1001, query: {}, referrerInfo: {} })
    }

    await ipcSend(mainWindow, 'dmb:dispose', { bridgeId: spawned.appSessionId })
  })

  test('carries a non-default scene and entry query through to the service realm', async ({ mainWindow, electronApp }) => {
    const spawned = await ipcInvoke<SpawnResult>(mainWindow, 'dmb:spawn', {
      appId: 'launch-options-e2e-custom',
      pagePath: 'pages/index/index',
      pkgRoot: FIXTURE_BUNDLE,
      root: 'main',
      scene: 1042,
      query: { foo: 'bar' },
    })
    await waitForServiceHost(electronApp)

    const snapshot = await readLaunchSnapshot(electronApp)
    for (const options of [snapshot.launch, snapshot.enter, snapshot.onLaunchArg]) {
      expect(options).toMatchObject({ path: 'pages/index/index', scene: 1042, query: { foo: 'bar' }, referrerInfo: {} })
    }

    await ipcSend(mainWindow, 'dmb:dispose', { bridgeId: spawned.appSessionId })
  })
})
