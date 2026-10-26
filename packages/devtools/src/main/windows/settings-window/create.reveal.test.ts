/**
 * Settings window reveal gate — regression for a `show: true` default flash.
 *
 * `new BrowserWindow(...)` defaults `show` to `true`, so without an explicit
 * `show: false` the window appears the instant it's constructed, well before
 * `loadFile` paints anything — a blank/white flash on every open. `closed`
 * (events.ts) fully destroys the window, so this hits on every reopen, not
 * just the first one.
 *
 * Contract (mirrors main-window/create.ts's `ready-to-show` gate):
 *  - the window is constructed with `show: false`.
 *  - it stays hidden until `ready-to-show` fires.
 *  - non-test env reveals via `show()`; test env reveals via `showInactive()`
 *    (matches `revealMainWindow`, reused from main-window/create.ts, so both
 *    windows can never pick different show methods).
 *
 * Harness: mock electron, capture the `once('ready-to-show', cb)` callback,
 * fire it manually, assert show()/showInactive() were / were not called
 * before that point.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const readyCbs = vi.hoisted(() => ({ list: [] as Array<() => void> }))

vi.mock('electron', async () => {
  const { createTestScreen } = await import('../../test-support/electron-screen.js')
  const app = { isPackaged: true }

  class WebContents {
    on = vi.fn()
    once = vi.fn()
    removeListener = vi.fn()
  }

  class BrowserWindow {
    webContents = new WebContents()
    show = vi.fn()
    showInactive = vi.fn()
    loadFile = vi.fn(() => Promise.resolve())
    once = vi.fn((event: string, cb: () => void) => {
      if (event === 'ready-to-show') readyCbs.list.push(cb)
    })
    on = vi.fn()
  }

  return { app, BrowserWindow, screen: createTestScreen(), default: {} }
})

vi.mock('../../utils/paths.js', () => ({ mainPreloadPath: '/stub/preload.cjs' }))
vi.mock('../../utils/theme.js', () => ({
  themeBg: vi.fn(() => '#ffffff'),
  syncDocumentTheme: vi.fn(),
}))
vi.mock('../navigation-hardening.js', () => ({ applyNavigationHardening: vi.fn() }))

let createSettingsWindow: typeof import('./create.js').createSettingsWindow
const savedNodeEnv = process.env.NODE_ENV

beforeEach(async () => {
  vi.resetModules()
  readyCbs.list.length = 0
  ;({ createSettingsWindow } = await import('./create.js'))
})

afterEach(() => {
  process.env.NODE_ENV = savedNodeEnv
})

function fireReadyToShow() {
  for (const cb of readyCbs.list) cb()
}

describe('createSettingsWindow reveal gate', () => {
  it('constructs the window hidden (show: false) and does not reveal it before ready-to-show', async () => {
    process.env.NODE_ENV = 'production'
    const winPromise = createSettingsWindow(null, '/renderer')
    const win = await winPromise

    expect(vi.mocked(win.show), 'must stay hidden until ready-to-show fires').not.toHaveBeenCalled()
    expect(vi.mocked(win.showInactive)).not.toHaveBeenCalled()
  })

  it('non-test env: ready-to-show reveals via show()', async () => {
    process.env.NODE_ENV = 'production'
    const win = await createSettingsWindow(null, '/renderer')

    fireReadyToShow()

    expect(vi.mocked(win.show)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(win.showInactive)).not.toHaveBeenCalled()
  })

  it('test env: ready-to-show reveals via showInactive(), never show()', async () => {
    process.env.NODE_ENV = 'test'
    const win = await createSettingsWindow(null, '/renderer')

    fireReadyToShow()

    expect(
      vi.mocked(win.showInactive),
      'test env reveals via showInactive (avoids stealing focus during e2e)',
    ).toHaveBeenCalledTimes(1)
    expect(vi.mocked(win.show)).not.toHaveBeenCalled()
  })
})
