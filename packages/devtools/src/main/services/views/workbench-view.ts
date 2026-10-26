import { nativeTheme, WebContentsView } from 'electron'
import { handleWindowOpenExternal } from '../../windows/navigation-hardening.js'
import { themeBg } from '../../utils/theme.js'
import { VIEW_ID } from '../../../shared/view-ids.js'
import type { PlacementReconciler } from './placement-reconciler.js'
import type { ViewManagerContext } from './view-manager.js'

/**
 * The opt-in VS Code workbench hosting the 'editor' dock slot. Lazily created
 * by `attachWorkbench` from the COI server URL; its bounds ride the renderer
 * 'editor'-slot anchor (forward anchor, like the simulator DevTools overlay).
 */
export interface WorkbenchView {
  attachWorkbench(url: string): Promise<void>
  setWorkbenchSource(url: string): void
  detachWorkbench(): void
  openFileInWorkbench(relPath: string, line: number, column: number): boolean
  holdWorkbenchAttach(): () => void
  cancelWorkbenchAttachHold(): void
}

/**
 * Upper bound on how long a hold may defer the workbench attach. A hung or
 * very slow first compile (or a lost release on some open path) degrades to a
 * bounded editor delay plus a warn — never a permanently blank editor slot.
 */
const ATTACH_HOLD_CAP_MS = 3000

export function createWorkbenchView(
  ctx: ViewManagerContext,
  reconciler: PlacementReconciler,
): WorkbenchView {
  let workbenchView: WebContentsView | null = null
  // Whether the devtools-theme → workbench-theme `nativeTheme` listener is live.
  // Bound lazily on first workbench attach, removed on detach.
  let workbenchThemeSyncBound = false
  // COI server base URL for the workbench, stored by `setWorkbenchSource`. The
  // heavy WebContentsView load is deferred until the 'editor' slot first becomes
  // visible (first non-zero `setWorkbenchBounds`) so it never sits on the app
  // boot critical path (which would delay preload/window-ready and trip the e2e
  // health check into a relaunch), and further deferred while an attach hold
  // (below) is in force.
  let workbenchUrl: string | null = null
  // Attach gate: while held (and the view does not exist yet), the lazy attach
  // is deferred so the workbench's heavy load never competes with a project
  // open's boot-critical window (old-session teardown + first compile) for
  // CPU. Generation-tagged: a newer hold supersedes an older one (latest-wins,
  // mirroring the open op-lock), so a superseded open's late release cannot
  // open a newer open's gate. The gate only postpones creation — it never
  // hides or destroys an existing view, and detachWorkbench leaves it intact
  // (an in-flight open holds across the old view's teardown).
  let attachHeld = false
  let attachHoldGeneration = 0
  let attachHoldTimer: ReturnType<typeof setTimeout> | null = null
  let pendingOpen: { path: string; line: number; column: number; epoch: number } | null = null
  let workbenchGeneration = 0
  let openRequestEpoch = 0

  /** Current devtools color scheme, mirrored into the workbench's theme. */
  function workbenchThemeScheme(): 'light' | 'dark' {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  }

  // Push the live devtools scheme into the workbench whenever it flips. The
  // workbench is a plain isolated http document, so drive its exposed
  // `__WB_SET_THEME` setter over executeJavaScript (mirrors openFileInWorkbench).
  // The setter only exists once the workbench's configuration service is
  // initialized; before then the URL-query initial value already covers the
  // current scheme, and a missing setter here is a tolerated no-op.
  function pushWorkbenchTheme(): void {
    if (!workbenchView || workbenchView.webContents.isDestroyed()) return
    const wc = workbenchView.webContents
    // Keep the WCV surface in sync with the active color scheme: the workbench
    // page can only recolor its own inner #workbench, never the html/body
    // backdrop, so the native surface must follow the theme flip too.
    try {
      if (typeof workbenchView.setBackgroundColor === 'function') workbenchView.setBackgroundColor(themeBg())
    } catch { /* view/wc gone mid-flip */ }
    if (typeof wc.executeJavaScript !== 'function') return
    const script = `window.__WB_SET_THEME && window.__WB_SET_THEME(${JSON.stringify(workbenchThemeScheme())})`
    wc.executeJavaScript(script, true).catch(() => { /* workbench not yet ready */ })
  }

  async function attachWorkbench(url: string): Promise<void> {
    if (workbenchView) return
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
      },
    })
    workbenchView = view
    // Paint the WCV surface the themed window background (themeBg(): dark
    // #0a0a0a / light #ffffff) so the boot screen ("booting workbench…") and
    // any layout gap never flash a mismatched white strip before the workbench
    // CSS loads. The workbench is a plain WebContentsView (not a BrowserWindow),
    // so the process-wide installThemeBackgroundSync() never reaches it — match
    // the main window's own backgroundColor here, and re-sync on every theme
    // flip below.
    try {
      view.setBackgroundColor(themeBg())
    } catch { /* view not ready for a bg yet */ }
    // Track devtools theme flips for the lifetime of the workbench view only —
    // registered here (not at construction) so test electron mocks that omit
    // `nativeTheme` and never open the editor stay unaffected. Removed in
    // detachWorkbench.
    if (!workbenchThemeSyncBound) {
      nativeTheme.on('updated', pushWorkbenchTheme)
      workbenchThemeSyncBound = true
    }
    // The workbench bundle loads arbitrary URLs (docs links, etc.); route popups
    // + cross-origin in-place navigation to the OS browser (mirror the host
    // toolbar / native simulator hardening).
    try {
      view.webContents.setWindowOpenHandler(({ url: target }) => handleWindowOpenExternal(target))
    } catch { /* stub may lack it */ }
    // Hand the workbench the current devtools scheme as a URL query so its very
    // first paint already matches (the runtime setter only exists post-init).
    // The project identity deliberately does NOT ride this URL: the attach can
    // happen before the open commits a session (the gate self-releases after
    // ATTACH_HOLD_CAP_MS on a slow compile, and the release fires just ahead of
    // the commit), so the page polls it from the COI server's `/__project`
    // instead — see workbench-coi-server.ts.
    const loadUrl = `${url}index.html?theme=${workbenchThemeScheme()}`
    await view.webContents.loadURL(loadUrl).catch((err) => {
      console.error('[workbench] attachWorkbench — loadURL failed', err)
    })
    void consumePendingOpen(view, ++workbenchGeneration)
  }

  /** Store the COI base URL; the heavy load happens lazily on first show. */
  function setWorkbenchSource(url: string): void {
    if (workbenchUrl !== url) {
      openRequestEpoch++
      pendingOpen = null
    }
    workbenchUrl = url
  }

  // Release the gate for `generation` (stale generations no-op) and replay the
  // reconcile so a pending visible desired attaches through the normal lazy
  // path. `viaCap` marks the self-release at the hold cap — loud, so a slow
  // compile and a lost release stay distinguishable from a normal settle.
  function releaseAttachHold(generation: number, viaCap: boolean): void {
    if (!attachHeld || generation !== attachHoldGeneration) return
    attachHeld = false
    if (attachHoldTimer) {
      clearTimeout(attachHoldTimer)
      attachHoldTimer = null
    }
    if (viaCap) {
      console.warn(
        `[workbench] attach gate: hold not released within ${ATTACH_HOLD_CAP_MS}ms (compile still running or a release was lost) — attaching now`,
      )
    }
    reconciler.reconcileNow()
  }

  /**
   * Close the attach gate until the returned release fn runs, a newer hold
   * supersedes it, explicit user intent (openFileInWorkbench) opens it, or the
   * cap timer fires. The release fn is idempotent and generation-bound.
   */
  function holdWorkbenchAttach(): () => void {
    const generation = ++attachHoldGeneration
    attachHeld = true
    if (attachHoldTimer) clearTimeout(attachHoldTimer)
    attachHoldTimer = setTimeout(() => releaseAttachHold(generation, true), ATTACH_HOLD_CAP_MS)
    return () => releaseAttachHold(generation, false)
  }

  /**
   * Void the current hold WITHOUT the release replay: the gate belongs to an
   * open request, and a teardown that preempts it (closeProject / app-level
   * disposeAll) invalidates that request — its late release or cap firing must
   * not rebuild the view after the project is gone. Bumping the generation
   * turns every pending release fn into a no-op; no-op when nothing is held.
   */
  function cancelWorkbenchAttachHold(): void {
    if (!attachHeld && !attachHoldTimer) return
    attachHeld = false
    attachHoldGeneration++
    if (attachHoldTimer) {
      clearTimeout(attachHoldTimer)
      attachHoldTimer = null
    }
  }

  function detachWorkbench(): void {
    workbenchGeneration++
    openRequestEpoch++
    pendingOpen = null
    if (workbenchThemeSyncBound) {
      nativeTheme.removeListener('updated', pushWorkbenchTheme)
      workbenchThemeSyncBound = false
    }
    reconciler.destroyView(VIEW_ID.workbench, workbenchView)
    workbenchView = null
    if (!attachHeld) {
      reconciler.deleteBaseDesired(VIEW_ID.workbench)
    }
    reconciler.reconcileNow()
  }

  // Build the `file:///workspace/<rel>` URI string with each path SEGMENT
  // percent-encoded. A raw `rel` passed to `vscode.Uri.parse` mis-parses a
  // filename containing `#` (treated as a fragment) or `?` (treated as a
  // query), opening the wrong document; encoding each segment (but not the
  // `/` separators) keeps the path structure while escaping the reserved
  // characters. Leading slashes are already stripped by the caller.
  function workspaceUriFor(rel: string): string {
    const encoded = rel.split('/').map(encodeURIComponent).join('/')
    return `file:///workspace/${encoded}`
  }

  // Reveal `uri` at the 0-based position in the workbench. A later request
  // advances the page-local epoch, so an older `openTextDocument` completion
  // cannot reveal over the newer selection.
  function tryRevealInWorkbench(uri: string, zeroLine: number, zeroCol: number, epoch: number): Promise<boolean> {
    if (!workbenchView || workbenchView.webContents.isDestroyed()) {
      return Promise.resolve(false)
    }
    const script = `(async () => {
      try {
        const requestEpoch = ${epoch}; window.__DIMINA_WORKBENCH_OPEN_EPOCH = requestEpoch
        const P = window.__WB_PROBE; if (!P) return false
        const vscode = P.vscode
        const uri = vscode.Uri.parse(${JSON.stringify(uri)})
        const doc = await vscode.workspace.openTextDocument(uri)
        if (window.__DIMINA_WORKBENCH_OPEN_EPOCH !== requestEpoch) return false
        const pos = new vscode.Position(${zeroLine}, ${zeroCol})
        await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) })
        return window.__DIMINA_WORKBENCH_OPEN_EPOCH === requestEpoch
      } catch (e) { return false }
    })()`
    return workbenchView.webContents
      .executeJavaScript(script, true)
      .then((ok) => ok === true)
      .catch(() => false)
  }

  function waitForWorkbenchReady(view: WebContentsView, generation: number): Promise<boolean> {
    if (view.webContents.isDestroyed()) return Promise.resolve(false)
    const script = `new Promise(resolve => { const finish = value => { window.removeEventListener('dimina-workbench-ready', onReady); window.removeEventListener('dimina-workbench-failed', onFailed); window.removeEventListener('pagehide', onPageHide); resolve(value) }; const onReady = () => finish(true); const onFailed = () => finish(false); const onPageHide = () => finish(false); if (window.__WB_READY) return finish(true); if (window.__WB_ERROR) return finish(false); window.addEventListener('dimina-workbench-ready', onReady, { once: true }); window.addEventListener('dimina-workbench-failed', onFailed, { once: true }); window.addEventListener('pagehide', onPageHide, { once: true }); })`
    return view.webContents.executeJavaScript(script, true).then(Boolean).catch(() => false)
      .then((ready) => ready && generation === workbenchGeneration && workbenchView === view)
  }

  async function consumePendingOpen(view: WebContentsView, generation: number): Promise<void> {
    if (!await waitForWorkbenchReady(view, generation)) return
    const request = pendingOpen
    if (!request) return
    pendingOpen = null
    const uri = workspaceUriFor(request.path.replace(/^\/+/, ''))
    await tryRevealInWorkbench(uri, Math.max(0, Math.floor(request.line) - 1), Math.max(0, Math.floor(request.column) - 1), request.epoch)
  }

  // Queue a project-file reveal for the embedded workbench. Source-link clicks
  // may arrive before lazy attach or before boot completes; readiness consumes
  // the latest request once, and the renderer receives the same notification
  // to restore a hidden editor dock panel.
  function openFileInWorkbench(relPath: string, line: number, column: number): boolean {
    // Explicit user intent (a source-link click) beats the boot-priority
    // scheduling: open the gate first so the release's reconcile replay can
    // lazy-create the view synchronously before the liveness check below.
    if (attachHeld) releaseAttachHold(attachHoldGeneration, false)
    const generation = workbenchGeneration
    pendingOpen = { path: relPath, line, column, epoch: ++openRequestEpoch }
    if (!workbenchView || workbenchView.webContents.isDestroyed()) return true
    void consumePendingOpen(workbenchView, generation)
    return true
  }

  // workbench is gated until it has a source or a live view (it lazy-creates
  // from the URL in the attach op), and while an attach hold is in force.
  reconciler.registerView(VIEW_ID.workbench, {
    getView: () => workbenchView,
    gateHidden: () => !workbenchView && (!workbenchUrl || attachHeld),
    ensureLazy: (desired) => {
      if (desired?.placement.visible && !workbenchView && workbenchUrl && !attachHeld) void attachWorkbench(workbenchUrl)
    },
  })

  return { attachWorkbench, setWorkbenchSource, detachWorkbench, openFileInWorkbench, holdWorkbenchAttach, cancelWorkbenchAttachHold }
}
