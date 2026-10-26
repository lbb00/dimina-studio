/**
 * MAIN WINDOW READY-TO-SHOW GATE FOR `revealWindow` (app/window-events.ts).
 *
 * `revealWindow` is the only path back to the list window (menu "回到项目
 * 列表", macOS Dock activate, the last project window closing). Force-
 * showing it before Chromium has painted the first frame — before this
 * module's own `ready-to-show` handler has fired — flashes blank content,
 * exactly the white-flash `ready-to-show` exists to prevent. `isMainWindowReady`
 * tracks which windows have cleared that gate; `revealWindow` must defer to
 * it instead of unconditionally calling `show()`.
 *
 * Harness mirrors `auto-show.test.ts`: mock electron, capture the
 * `once('ready-to-show', cb)` callback, fire it manually.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const readyCbs = vi.hoisted(() => ({ list: [] as Array<() => void> }))

vi.mock('electron', async () => {
  const { createTestScreen } = await import('../../test-support/electron-screen.js')
  const app = { isPackaged: true }

  class WebContents {
    id = Math.floor(Math.random() * 1e6)
    setWindowOpenHandler = vi.fn()
    on = vi.fn()
    once = vi.fn()
    openDevTools = vi.fn()
    loadFile = vi.fn(() => Promise.resolve())
  }

  class View {
    children: View[] = []
    addChildView(child: View) { this.children.push(child) }
    removeChildView(child: View) {
      const i = this.children.indexOf(child)
      if (i >= 0) this.children.splice(i, 1)
    }
  }

  class WebContentsView extends View {
    webContents = new WebContents()
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
  }

  class BrowserWindow {
    destroyed = false
    minimized = false
    webContents = new WebContents()
    contentView: View | WebContentsView = new WebContentsView()
    isDestroyed = () => this.destroyed
    isMinimized = () => this.minimized
    restore = vi.fn(() => { this.minimized = false })
    show = vi.fn()
    showInactive = vi.fn()
    focus = vi.fn()
    setIcon = vi.fn()
    loadFile = vi.fn(() => Promise.resolve())
    once = vi.fn((event: string, cb: () => void) => {
      if (event === 'ready-to-show') readyCbs.list.push(cb)
    })
    on = vi.fn()
  }

  const nativeTheme = { themeSource: 'system' }

  return {
    app,
    BrowserWindow,
    View,
    WebContentsView,
    BrowserView: WebContentsView,
    nativeTheme,
    screen: createTestScreen(),
    default: {},
  }
})

let createMainWindow: typeof import('./create.js').createMainWindow
let isMainWindowReady: typeof import('./create.js').isMainWindowReady
let revealWindow: typeof import('../../app/window-events.js').revealWindow
const savedNodeEnv = process.env.NODE_ENV

beforeEach(async () => {
  vi.resetModules()
  readyCbs.list.length = 0
  process.env.NODE_ENV = 'production'
  ;({ createMainWindow, isMainWindowReady } = await import('./create.js'))
  ;({ revealWindow } = await import('../../app/window-events.js'))
})

afterEach(() => {
  process.env.NODE_ENV = savedNodeEnv
})

function fireReadyToShow() {
  for (const cb of readyCbs.list) cb()
}

describe('isMainWindowReady tracks the ready-to-show gate', () => {
  it('is false before ready-to-show fires and true after', () => {
    const win = createMainWindow({ indexHtml: '/fake/index.html' })
    expect(isMainWindowReady(win)).toBe(false)

    fireReadyToShow()

    expect(isMainWindowReady(win)).toBe(true)
  })
})

describe('revealWindow defers to the main window ready-to-show gate', () => {
  it('does not force show()/focus() on a window that has not painted its first frame yet', () => {
    const win = createMainWindow({ indexHtml: '/fake/index.html' })

    revealWindow(win)

    expect(
      vi.mocked(win.show),
      'forcing a mid-paint window visible would flash blank content — the ready-to-show handler reveals it once ready',
    ).not.toHaveBeenCalled()
    expect(vi.mocked(win.focus)).not.toHaveBeenCalled()
  })

  it('shows and focuses normally once ready-to-show has already fired', () => {
    const win = createMainWindow({ indexHtml: '/fake/index.html' })
    fireReadyToShow()
    vi.mocked(win.show).mockClear() // ready-to-show's own handler already called show() once

    revealWindow(win)

    expect(vi.mocked(win.show)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(win.focus)).toHaveBeenCalledTimes(1)
  })

  it('restores a ready, minimized window before showing/focusing it', () => {
    const win = createMainWindow({ indexHtml: '/fake/index.html' })
    fireReadyToShow()
    vi.mocked(win.show).mockClear()
    ;(win as unknown as { minimized: boolean }).minimized = true

    revealWindow(win)

    expect(vi.mocked(win.restore)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(win.show)).toHaveBeenCalledTimes(1)
  })
})
