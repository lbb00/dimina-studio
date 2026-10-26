/**
 * Settings window pre-first-paint failure fallback — regression for a
 * permanent "window exists but is unreachable" deadlock.
 *
 * The reveal gate (create.reveal.test.ts) keeps the window hidden until
 * `ready-to-show` fires. If the renderer fails BEFORE painting a first frame
 * (bad load, crashed/killed process), Electron never fires `ready-to-show` —
 * the window stays hidden forever: alive per `isDestroyed()`, but
 * `isSettingsWindowReady()` permanently false, so `openSettingsWindow`'s
 * ready-gated `show()` never runs and the window is unreachable until the
 * app restarts.
 *
 * Contract:
 *  - `did-fail-load` before `ready-to-show` destroys the window.
 *  - `render-process-gone` before `ready-to-show` destroys the window.
 *  - once `ready-to-show` has fired, a later `did-fail-load` (normal
 *    in-use navigation failure) must NOT destroy the window.
 *
 * Harness: mock electron with per-instance event capture on both the window
 * and its webContents (`once`/`removeListener`/`emit`), so the test can fire
 * `did-fail-load` / `render-process-gone` / `ready-to-show` independently and
 * assert on `destroy()`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', async () => {
  const { createTestScreen } = await import('../../test-support/electron-screen.js')
  const app = { isPackaged: true }

  class Emitter {
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const arr = this.listeners.get(event) ?? []
      arr.push(cb)
      this.listeners.set(event, arr)
    })
    once = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const arr = this.listeners.get(event) ?? []
      arr.push(cb)
      this.listeners.set(event, arr)
    })
    removeListener = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const arr = this.listeners.get(event)
      if (!arr) return
      const i = arr.indexOf(cb)
      if (i >= 0) arr.splice(i, 1)
    })
    emit(event: string, ...args: unknown[]) {
      for (const fn of [...(this.listeners.get(event) ?? [])]) fn(...args)
    }
  }

  class WebContents extends Emitter {}

  class BrowserWindow extends Emitter {
    webContents = new WebContents()
    show = vi.fn()
    showInactive = vi.fn()
    loadFile = vi.fn(() => Promise.resolve())
    private destroyed = false
    destroy = vi.fn(() => { this.destroyed = true })
    isDestroyed = vi.fn(() => this.destroyed)
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

beforeEach(async () => {
  vi.resetModules()
  ;({ createSettingsWindow } = await import('./create.js'))
})

describe('createSettingsWindow pre-first-paint failure fallback', () => {
  it('destroys the window when did-fail-load fires before ready-to-show', async () => {
    const win = await createSettingsWindow(null, '/renderer')

    expect(vi.mocked(win.destroy)).not.toHaveBeenCalled()
    win.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'file://x', true)

    expect(vi.mocked(win.destroy)).toHaveBeenCalledTimes(1)
  })

  it('does not destroy the window when a subframe (not the main frame) fails to load', async () => {
    const win = await createSettingsWindow(null, '/renderer')

    win.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'file://x', false)

    expect(
      vi.mocked(win.destroy),
      'a subframe load failure must not tear down a window whose main frame never failed',
    ).not.toHaveBeenCalled()

    // The main frame can still fail afterward — the listener must still be live.
    win.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'file://main', true)
    expect(vi.mocked(win.destroy)).toHaveBeenCalledTimes(1)
  })

  it('destroys the window when render-process-gone fires before ready-to-show', async () => {
    const win = await createSettingsWindow(null, '/renderer')

    win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })

    expect(vi.mocked(win.destroy)).toHaveBeenCalledTimes(1)
  })

  it('does not destroy an already-painted window on a later navigation failure', async () => {
    const win = await createSettingsWindow(null, '/renderer')

    // First paint completed — the fallback listeners must be torn down here.
    win.emit('ready-to-show')

    win.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'file://x', true)

    expect(
      vi.mocked(win.destroy),
      'a normal in-use navigation failure after ready-to-show must not tear down the window',
    ).not.toHaveBeenCalled()
  })
})
