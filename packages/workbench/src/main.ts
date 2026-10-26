/**
 * Prebuilt static-bundle entry for the devtools embedded editor.
 *
 * This is the page the devtools COI server serves: a disk-mirrored workbench
 * (its file source is the active project, read/written over the COI `/__fs`
 * bridge) with all dimina language features on. The reusable boot lives in
 * `bootWorkbench`; this entry only wires the devtools host specifics — the
 * disk-mirror source keyed off the COI origin, the theme passed via the page
 * URL query, and the `window.__WB_*` probe/status surface the harness and the
 * main process drive over CDP / executeJavaScript.
 */
import { bootWorkbench } from './boot'
import { diskMirrorSource } from './workspace/disk-workspace-source'
import type { CustomFileTypes } from './file-type-associations'
import { HOST_BASE_URL } from './host-base-url.js'
import { connectCompilerDiagnostics } from './compiler-diagnostics.js'

declare global {
  interface Window {
    __WB_STATUS?: string
    __WB_ERROR?: string
    /**
     * Apply a devtools color scheme to the workbench. The main process drives
     * this over `executeJavaScript` whenever the devtools theme flips so the
     * editor tracks the surrounding app's light/dark scheme.
     */
    __WB_SET_THEME?: (scheme: 'light' | 'dark') => void
  }
}

/** Devtools color scheme passed via `index.html?theme=light|dark`; dark default. */
function initialThemeScheme(): 'light' | 'dark' {
  return new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark'
}

/**
 * Wait for the COI server's `/__project` to report the active project's
 * workspace id — the name this page's VS Code workspace takes, so each miniapp
 * gets its own open-editors/view-state bucket instead of all of them sharing the
 * one derived from the constant `file:///workspace` mirror root (see boot.ts).
 *
 * Polled, not read once, because this page is loaded as soon as the editor slot
 * paints, which can be BEFORE the project open commits its session (the host's
 * attach gate self-releases on a slow compile) — exactly when a cold open would
 * otherwise get no identity. Same ~30s budget and cadence as the disk mirror's
 * own wait for the project root to appear (file-workspace.ts), after which we
 * boot without an id and the editor keeps that state session-local rather than
 * writing it to a bucket shared with every other project.
 */
async function awaitProjectWorkspaceId(): Promise<string | undefined> {
  // Publish the wait: this is the one phase before `bootWorkbench` owns the
  // status, and it is also what lets a CDP probe recognize this page.
  window.__WB_STATUS = 'awaiting-project'
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`${HOST_BASE_URL}__project`)
      if (res.ok) {
        const { workspaceId } = (await res.json()) as { workspaceId?: string | null }
        if (workspaceId) return workspaceId
      }
    } catch {
      // Server not up yet / transient — retried below.
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  console.warn('[workbench] no project identity from /__project — editor state stays session-local')
  return undefined
}

/**
 * Pull the host's custom file types from the COI server's `/__filetypes`
 * endpoint (the same bridge that serves `/__fs` + `/__contrib`). Best-effort:
 * a missing endpoint, non-OK status, or parse error → undefined (built-in
 * associations only), so the editor still boots.
 */
async function loadFileTypes(): Promise<CustomFileTypes | undefined> {
  try {
    const res = await fetch(`${HOST_BASE_URL}__filetypes`)
    if (!res.ok) return undefined
    return (await res.json()) as CustomFileTypes
  } catch {
    return undefined
  }
}

async function boot(): Promise<void> {
  const container = document.getElementById('workbench')!
  // This window's slice of the shared COI host — see host-base-url.ts.
  const fsBaseUrl = HOST_BASE_URL

  // Both are host lookups the boot cannot start without (the workspace identity
  // is fixed when the monaco services initialize, and the associations go into
  // the very first user config) — run them concurrently so the slow one, not
  // their sum, gates the editor.
  const [workspaceId, fileTypes] = await Promise.all([awaitProjectWorkspaceId(), loadFileTypes()])

  const workspace = diskMirrorSource({ fsBaseUrl })

  const handle = await bootWorkbench({
    container,
    workspace,
    workspaceId,
    theme: initialThemeScheme(),
    fileTypes,
    exposeProbe: true,
    onStatus: (s) => {
      window.__WB_STATUS = s
    },
  })

  window.__WB_SET_THEME = handle.setTheme
  const compilerDiagnostics = connectCompilerDiagnostics(handle.vscode, HOST_BASE_URL)
  window.addEventListener('pagehide', () => compilerDiagnostics.dispose(), { once: true })
  const bootEl = document.getElementById('boot')
  if (bootEl) bootEl.remove()
}

boot().catch((err: unknown) => {
  window.__WB_ERROR = err instanceof Error && err.stack ? err.stack : String(err)
  window.__WB_STATUS = 'error'
  window.dispatchEvent(new Event('dimina-workbench-failed'))
  const bootEl = document.getElementById('boot')
  if (bootEl) bootEl.textContent = 'workbench boot error: ' + window.__WB_ERROR
  console.error('[workbench] boot failed', err)
})
