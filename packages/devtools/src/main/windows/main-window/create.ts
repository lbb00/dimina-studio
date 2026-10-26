import { app, BrowserWindow, screen, View, WebContentsView } from 'electron'
import path from 'path'
import { mainPreloadPath } from '../../utils/paths.js'
import { syncDocumentTheme, themeBg } from '../../utils/theme.js'
import { applyNavigationHardening } from '../navigation-hardening.js'
import { getWindowSizeOptions } from '../../utils/window-size.js'
import { loadWindowGeometry, saveWindowGeometry } from './window-geometry.js'

export interface WindowOptions {
  title?: string
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
  indexHtml: string
  /**
   * Query string appended to the loaded `file://` URL. This is how a window
   * receives its own bootstrap identity (the workbench window reads the project
   * it belongs to from here), so the renderer entry knows what to mount without
   * a round-trip. Survives navigation-hardening: that check matches on the
   * `file://` prefix only and ignores the query (see navigation-hardening.ts).
   */
  query?: Record<string, string>
  /**
   * Auto-show the window on `ready-to-show` in non-test envs. Defaults to
   * `true`. `false` lets a login-gating host keep the window hidden and call
   * `show()` itself. The test env always uses `showInactive()` regardless.
   */
  autoShow?: boolean
  /** Stable owner identity for a window's persisted outer bounds. */
  geometryKey?: string
}

// Windows that have cleared their own `ready-to-show` gate below.
// `revealWindow` (app/window-events.ts) reads this before forcing `show()`
// on a hidden main window — showing it before Chromium has painted the
// first frame would flash blank content, exactly what this gate exists to
// prevent. Membership tracks the window instance, not a lifecycle phase, so
// a destroyed window simply falls out of reach — no explicit cleanup needed.
const readyWindows = new WeakSet<BrowserWindow>()
let nextGeometryOwner = 0
const latestGeometryOwner = new Map<string, number>()

export function isMainWindowReady(win: BrowserWindow): boolean {
  return readyWindows.has(win)
}

/**
 * Shows `win` the way the current env expects: `showInactive()` in test env
 * so e2e windows don't steal focus, `show()` otherwise. Shared by this
 * module's own `ready-to-show` handler and by the workbench window manager's
 * reveal-after-hook-and-paint gate (`workbench-window.ts`), so the two reveal
 * paths can never pick different show methods.
 */
export function revealMainWindow(win: BrowserWindow): void {
  if (process.env.NODE_ENV === 'test') win.showInactive()
  else win.show()
}

export function createMainWindow(opts: WindowOptions): BrowserWindow {
  const restoredBounds = opts.geometryKey ? loadWindowGeometry(opts.geometryKey) : undefined
  const size = getWindowSizeOptions({
    width: opts.width ?? 1280,
    height: opts.height ?? 980,
    minWidth: opts.minWidth ?? 640,
    minHeight: opts.minHeight ?? 480,
  }, screen, restoredBounds, restoredBounds)
  const mainWindow = new BrowserWindow({
    ...size,
    title: opts.title ?? 'Dimina DevTools',
    show: false,
    backgroundColor: themeBg(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // `sandbox: false` is required so the preload bundle can `require('electron')`
      // to access contextBridge/ipcRenderer. The renderer itself runs isolated.
      sandbox: false,
      preload: mainPreloadPath,
    },
  })

  if (opts.geometryKey) {
    const geometryKey = opts.geometryKey
    const geometryOwner = ++nextGeometryOwner
    latestGeometryOwner.set(geometryKey, geometryOwner)
    let closingBounds: ReturnType<BrowserWindow['getBounds']> | undefined
    const captureGeometry = () => {
      try {
        closingBounds = mainWindow.isMaximized() || mainWindow.isFullScreen()
          ? mainWindow.getNormalBounds()
          : mainWindow.getBounds()
      } catch (error) {
        console.warn('[window] failed to capture geometry:', error)
      }
    }
    captureGeometry()
    mainWindow.on('resize', captureGeometry)
    mainWindow.on('move', captureGeometry)
    mainWindow.on('close', captureGeometry)
    mainWindow.once('closed', () => {
      if (latestGeometryOwner.get(geometryKey) !== geometryOwner) return
      latestGeometryOwner.delete(geometryKey)
      if (readyWindows.has(mainWindow) && closingBounds) saveWindowGeometry(geometryKey, closingBounds)
    })
  }

  mainWindow.once('ready-to-show', () => {
    readyWindows.add(mainWindow)
    const isTest = process.env.NODE_ENV === 'test'
    // Visibility is governed by `autoShow` in BOTH envs. A login-gating host
    // opts out via `autoShow: false` and reveals the window itself once auth
    // passes — don't flash an un-authed window. The framework must never
    // force-show when the host opted out, in test env either (that would
    // fight the host's own reveal handler).
    if (opts.autoShow !== false) revealMainWindow(mainWindow)
    // Don't auto-open a detached DevTools for the devtools UI shell itself —
    // it's noise for normal use (the mini-app's Console lives in the embedded
    // right-panel DevTools, not here). Opt in via env for debugging the shell.
    if (!isTest && !app.isPackaged && process.env.DIMINA_DEVTOOLS_MAIN_INSPECTOR === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  })

  const rendererDir = path.dirname(opts.indexHtml)

  // Restrict the main renderer to file:// URLs under the renderer bundle and
  // route every popup through the OS browser. See navigation-hardening.ts.
  applyNavigationHardening(mainWindow.webContents, rendererDir)

  // Programmatic nativeTheme values are not reflected reliably through the
  // renderer's prefers-color-scheme on first load. Every DevTools-owned window
  // therefore receives an explicit class when its document becomes ready;
  // the process-wide listener handles subsequent switches.
  mainWindow.webContents.on('did-finish-load', () => {
    syncDocumentTheme(mainWindow.webContents)
  })

  mainWindow.loadFile(opts.indexHtml, opts.query ? { query: opts.query } : undefined)

  const container = new View()
  const mainWebView = mainWindow.contentView as WebContentsView
  container.addChildView(mainWebView)
  mainWindow.contentView = container

  return mainWindow
}
