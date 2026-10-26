import { BrowserWindow, nativeTheme } from 'electron'
import { toDisposable, type Disposable } from 'electron-deck/main'
import { WorkbenchSettingsChannel } from '../../shared/ipc-channels.js'

/**
 * Background color that matches the current system color scheme.
 * Pass as `backgroundColor` when creating BrowserWindows to prevent
 * a white or black flash before the renderer CSS loads.
 *
 * Dark:  oklch(0.145 0 0) ≈ #0a0a0a  (--background)
 * Light: oklch(1 0 0) = #ffffff  (--background)
 */
export function themeBg(): string {
  return nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff'
}

/**
 * Backdrop ("desk") color for the native simulator WebContentsView — the
 * surface the simulated phone sits on. Unlike {@link themeBg} (the window bg),
 * the desk is a neutral grey kept a touch off the window so the light-colored
 * phone keeps contrast against it in BOTH schemes.
 *
 * Dark: #282828 | Light: #f7f7f9 — both match the renderer's simulator desk.
 *
 * MUST stay equal to the renderer's `--color-sim-bg` (design.css) and the
 * simulator page's `.device-shell-root` background (device-shell.css): the WCV,
 * the desk, and the placeholder behind it are the same color so a height-resize
 * never flashes a mismatched strip. Update all three together.
 */
export function simDeskBg(): string {
  return nativeTheme.shouldUseDarkColors ? '#282828' : '#f7f7f9'
}

interface ThemeWebContents {
  isDestroyed(): boolean
  executeJavaScript?(script: string, userGesture?: boolean): Promise<unknown>
  on?(event: 'did-finish-load', listener: () => void): unknown
  once?(event: 'destroyed', listener: () => void): unknown
  removeListener?(event: 'did-finish-load' | 'destroyed', listener: () => void): unknown
}

const ownedThemeDocuments = new Set<ThemeWebContents>()

function currentThemeIsDark(): boolean {
  try {
    return nativeTheme.shouldUseDarkColors
  } catch {
    // Keeps partial Electron test doubles usable; real Electron always exposes
    // nativeTheme once these main-process helpers can run.
    return false
  }
}

export function syncDocumentTheme(
  contents: ThemeWebContents | undefined,
  isDark = currentThemeIsDark(),
): void {
  if (!contents || contents.isDestroyed() || typeof contents.executeJavaScript !== 'function') return
  const script = `document.documentElement.classList.toggle('dark', ${isDark}); document.documentElement.classList.toggle('light', ${!isDark})`
  contents.executeJavaScript(script, true).catch(() => { /* document closed during the theme switch */ })
}

/**
 * Register a DevTools-owned WebContentsView document for initial-load and
 * subsequent theme synchronization. Host-controlled slot documents must not
 * register here: their document classes belong to the embedding host.
 */
export function registerThemeDocument(contents: ThemeWebContents): Disposable {
  let disposed = false
  const apply = () => syncDocumentTheme(contents)
  const dispose = () => {
    if (disposed) return
    disposed = true
    ownedThemeDocuments.delete(contents)
    contents.removeListener?.('did-finish-load', apply)
    contents.removeListener?.('destroyed', dispose)
  }

  ownedThemeDocuments.add(contents)
  contents.on?.('did-finish-load', apply)
  contents.once?.('destroyed', dispose)
  apply()
  return toDisposable(dispose)
}

/**
 * Install a single process-wide listener that keeps every window's native
 * `backgroundColor` in sync with the active color scheme.
 *
 * A window's `backgroundColor` is otherwise frozen at the value passed to its
 * constructor: after a theme switch the stale color bleeds through wherever
 * native chrome and the WebContents meet. On Windows/Linux (in-window menu
 * bar) it shows as a light hairline between the menu bar and the page; on
 * macOS (global menu bar) it is latent — only a wrong-color flash on resize.
 * The defect is platform-agnostic, so the fix is too: one `nativeTheme`
 * `updated` listener re-syncs every live BrowserWindow. Newly loaded windows
 * get their initial class from `createMainWindow`'s document-load hook.
 *
 * Known limitation: on some Linux desktops (KDE Plasma + Wayland and other
 * wlroots compositors) an OS-level system theme change flips `updated` with
 * a stale/inverted `shouldUseDarkColors` instead of the correct value — a
 * Chromium ≥142 regression (electron/electron#48736, crbug 462191707, open
 * as of 2026-06) distinct from the older #25925 (fixed since Electron 13,
 * 2021). GNOME/GTK-portal desktops are unaffected. In-app theme switches go
 * through `applyTheme()` and are unaffected on every platform; the gap is
 * limited to the affected Linux desktops + `theme: 'system'` + an OS theme
 * change, an upstream Electron limitation that also leaves the renderer's
 * `prefers-color-scheme` stale.
 *
 * Returns a Disposable that detaches the listener. Install it once during
 * app setup and hand the Disposable to the workbench registry.
 */
export function installThemeBackgroundSync(): Disposable {
  const apply = () => {
    const bg = themeBg()
    const isDark = nativeTheme.shouldUseDarkColors
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      // Isolate each window: a window closing mid-loop (or a renderer torn down
      // between the isDestroyed() check and the send) must not abort the sync
      // for the remaining windows.
      try {
        win.setBackgroundColor(bg)
        // Notify renderer JS consumers that can't observe the CSS
        // `prefers-color-scheme` change (Monaco's theme). Electron does not
        // dispatch the renderer's matchMedia change event for programmatic
        // `nativeTheme.themeSource` flips, so push it from here — the one place
        // that already centralizes color-scheme reactions.
        if (!win.webContents.isDestroyed()) {
          win.webContents.send(WorkbenchSettingsChannel.ThemeChanged, isDark)
        }
        syncDocumentTheme(win.webContents, isDark)
      } catch { /* window/webContents gone mid-loop */ }
    }
    for (const contents of [...ownedThemeDocuments]) {
      if (contents.isDestroyed()) {
        ownedThemeDocuments.delete(contents)
      } else {
        syncDocumentTheme(contents, isDark)
      }
    }
  }
  nativeTheme.on('updated', apply)
  // The selected theme is restored before the launcher is created. Installing
  // this listener after that creation must still initialize the existing
  // document: assigning the same theme later emits no `updated` event.
  apply()
  return toDisposable(() => {
    nativeTheme.removeListener('updated', apply)
  })
}
