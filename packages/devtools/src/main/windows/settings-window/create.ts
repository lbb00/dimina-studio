import { BrowserWindow, screen } from 'electron'
import path from 'path'
import { mainPreloadPath } from '../../utils/paths.js'
import { syncDocumentTheme, themeBg } from '../../utils/theme.js'
import { applyNavigationHardening } from '../navigation-hardening.js'
import { revealMainWindow } from '../main-window/create.js'
import { getWindowSizeOptions } from '../../utils/window-size.js'

// Windows that have cleared their own `ready-to-show` reveal gate below.
// `openSettingsWindow` reads this to decide whether it's safe to `show()`
// a freshly created window immediately, or whether it must defer to the
// `ready-to-show` handler instead (see index.ts). Membership tracks the
// window instance, not a lifecycle phase, so a destroyed window simply
// falls out of reach — no explicit cleanup needed.
const readyWindows = new WeakSet<BrowserWindow>()

export function isSettingsWindowReady(win: BrowserWindow): boolean {
  return readyWindows.has(win)
}

export async function createSettingsWindow(
  parent: BrowserWindow | null | undefined,
  rendererDir: string,
): Promise<BrowserWindow> {
  const size = getWindowSizeOptions({
    width: 420,
    height: 560,
    minWidth: 380,
    minHeight: 480,
  }, screen, parent?.getBounds())
  const win = new BrowserWindow({
    ...size,
    parent: parent ?? undefined,
    title: '开发工具设置',
    show: false,
    backgroundColor: themeBg(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: mainPreloadPath,
    },
  })

  // If the renderer fails before painting a first frame — a bad load
  // (`did-fail-load`) or a crashed/killed process (`render-process-gone`) —
  // Electron never fires `ready-to-show`. Without this fallback the window
  // would sit hidden forever: still alive per `isDestroyed()`, but
  // `isSettingsWindowReady()` permanently false, so `openSettingsWindow`'s
  // ready-gated show() never fires and the window becomes unreachable until
  // the app restarts. Destroying it here recovers on either failure timing:
  // while `loadFile` below is still pending, destroying `win` makes Electron
  // reject that `loadFile` call, which `getOrCreateSettingsWindow` (index.ts)
  // catches to clear its in-flight-creation state; once `loadFile` has
  // resolved, `destroy()` fires `closed` (events.ts), which clears the
  // window's registration slot. Either way the next `openSettingsWindow` call
  // builds a fresh window instead of reusing the dead one.
  //
  // Scoped to the pre-first-paint window only: once `ready-to-show` fires,
  // both listeners are torn down below so a later navigation failure on a
  // window the user is actively looking at doesn't get treated as fatal.
  const destroyBeforeFirstPaint = () => {
    if (!win.isDestroyed()) win.destroy()
  }
  // `did-fail-load` fires per-frame; a failed subframe must not tear down the
  // whole window before the main frame itself has had a chance to paint, so
  // this stays `on` (not `once`) and filters to the main frame.
  const onDidFailLoad = (
    _event: unknown,
    _errorCode: number,
    _errorDescription: string,
    _validatedURL: string,
    isMainFrame: boolean,
  ): void => {
    if (isMainFrame) destroyBeforeFirstPaint()
  }
  win.webContents.on('did-fail-load', onDidFailLoad)
  win.webContents.once('render-process-gone', destroyBeforeFirstPaint)

  // Stay hidden until Chromium has painted the first frame, same reveal gate
  // as the main window (see main-window/create.ts) — otherwise the window
  // appears blank for the duration of loadFile below. `closed` (events.ts)
  // fully destroys this window, so a reopened settings window re-runs this
  // gate every time, not just on first launch.
  win.once('ready-to-show', () => {
    win.webContents.removeListener('did-fail-load', onDidFailLoad)
    win.webContents.removeListener('render-process-gone', destroyBeforeFirstPaint)
    readyWindows.add(win)
    revealMainWindow(win)
  })

  // Standalone settings window loads mainPreloadPath, so the same
  // navigation rules as the main window apply — see navigation-hardening.ts.
  applyNavigationHardening(win.webContents, rendererDir)

  win.webContents.on('did-finish-load', () => {
    syncDocumentTheme(win.webContents)
  })

  await win.loadFile(path.join(rendererDir, 'entries/workbench-settings/index.html'))
  return win
}
