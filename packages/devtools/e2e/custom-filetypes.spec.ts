/**
 * Custom file types (`.altml`/`.altss`/`.alts`) end-to-end against a real devtools
 * runtime configured with `WorkbenchAppConfig.fileTypes`.
 *
 * Two contracts, one launch:
 *  - Compilation: a page authored in `.altml` + `.altss` compiles (template→wxml,
 *    style→css) and renders. Proven by reading the render guest DOM: the marker
 *    text appears and the `.altss` color rule is applied.
 *  - Editor: the embedded VS Code workbench classifies the custom extensions by
 *    languageId (altml→wxml / altss→css / alts→javascript) and the wxml language
 *    service answers a completion on the `.altml` buffer — the same languageId
 *    that drives TextMate highlighting drives the LSP providers.
 *
 * Uses its own launch entry (custom-filetypes-verify-entry.js) because the shared fixture
 * boots the stock app with no fileTypes; this one passes the fileTypes config.
 */
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { _electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { applyInEditorLayoutPreset, openProjectInUI, pollUntil, RENDER_GUEST_URL_MARKER, findMainWindow } from './helpers'
import { attachWorkbenchAndWaitReady, runInWorkbench } from './workbench-probe'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, 'fixtures', 'custom-filetypes-app')

const dataBase = (process.env.DIMINA_DEVTOOLS_DATA_DIR
  ?? (fs.existsSync('/Volumes/jdisk') ? '/Volumes/jdisk/electron-data/dimina-devtools-e2e' : null))
  ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e')

/** Concatenated visible text of every render-host page guest (__frame__.html). */
async function readRenderText(app: ElectronApplication): Promise<string> {
  try {
    return await app.evaluate(async ({ webContents }, urlMarker) => {
      const frames = webContents.getAllWebContents()
        .filter((wc) => !wc.isDestroyed() && wc.getURL().includes(urlMarker))
      const out: string[] = []
      for (const f of frames) {
        try { out.push((await f.executeJavaScript('document.body.innerText')) as string) } catch {}
      }
      return out.join('\n---\n')
    }, RENDER_GUEST_URL_MARKER)
  } catch { return '' }
}

/** Computed style of the element whose text is exactly `marker`, read in the render guest. */
async function readStyledMarker(app: ElectronApplication, marker: string): Promise<{ found: boolean; color?: string; fontWeight?: string }> {
  return app.evaluate(async ({ webContents }, payload) => {
    const frames = webContents.getAllWebContents()
      .filter((wc) => !wc.isDestroyed() && wc.getURL().includes(payload.urlMarker))
    for (const f of frames) {
      try {
        const r = await f.executeJavaScript(`(() => {
          const all = Array.from(document.querySelectorAll('*'));
          const el = all.find(e => e.children.length === 0 && (e.textContent||'').trim() === ${JSON.stringify(payload.m)});
          if (!el) return { found: false };
          const c = getComputedStyle(el);
          return { found: true, color: c.color, fontWeight: c.fontWeight };
        })()`) as { found: boolean; color?: string; fontWeight?: string }
        if (r && r.found) return r
      } catch {}
    }
    return { found: false }
  }, { m: marker, urlMarker: RENDER_GUEST_URL_MARKER })
}

const EDITOR_PROBE = `(async () => {
  const probe = window.__WB_PROBE
  if (!probe) return { status: window.__WB_STATUS, noProbe: true }
  const { vscode, URI } = probe
  const open = async (filePath) => {
    try {
      const document = await vscode.workspace.openTextDocument(URI.parse('file:///workspace/' + filePath))
      return document.languageId
    } catch (error) {
      return 'ERR:' + String(error)
    }
  }
  const altml = await open('pages/index/index.altml')
  const altss = await open('pages/index/index.altss')
  const alts = await open('pages/index/util.alts')
  let tagSample = []
  try {
    const uri = URI.parse('file:///workspace/pages/index/index.altml')
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, new vscode.Position(0, 1))
    const items = (list && list.items) || []
    tagSample = items.map((item) => typeof item.label === 'string' ? item.label : item.label?.label).filter(Boolean).slice(0, 60)
  } catch (error) {
    tagSample = ['ERR:' + String(error)]
  }
  return { status: window.__WB_STATUS, altml, altss, alts, tagSample }
})()`

test.describe('Custom file types (.altml/.altss/.alts) — render + editor', () => {
  test.setTimeout(180_000)
  let app: ElectronApplication
  let workbench: Page

  test.beforeAll(async () => {
    // Launch + addProject + first compile easily exceeds Playwright's default
    // 60s hook budget; raise the hook timeout (the describe-level setTimeout
    // only governs test bodies, not hooks).
    test.setTimeout(150_000)
    const userDataDir = path.join(dataBase, 'userdata', 'custom-filetypes')
    fs.mkdirSync(userDataDir, { recursive: true })
    app = await _electron.launch({
      args: [path.resolve(__dirname, 'custom-filetypes-verify-entry.js'), `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test' },
    })
    const mainWindow = await findMainWindow(app)
    await mainWindow.waitForLoadState('domcontentloaded')
    await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      if (w) { w.setPosition(-2000, -2000); w.blur() }
    })
    workbench = await openProjectInUI(app, FIXTURE, { waitMs: 60_000 })
  })

  test.afterAll(async () => { await app?.close() })

  test('compilation: .altml renders and .altss styling is applied', async () => {
    const text = await pollUntil(() => readRenderText(app), (t) => t.includes('ALTML_RENDER_OK'), 60_000, 1000)
    expect(text, 'render guest should show the .altml marker').toContain('ALTML_RENDER_OK')
    expect(text, 'second .altml view should render too').toContain('ALTSS_STYLED')

    const styled = await pollUntil(
      () => readStyledMarker(app, 'ALTSS_STYLED'),
      (r) => r.found && r.color === 'rgb(200, 30, 40)',
      30_000, 1000,
    )
    expect(styled.found, 'the ALTSS_STYLED element must exist in the render DOM').toBe(true)
    expect(styled.color, '.altss color rule must be compiled+applied').toBe('rgb(200, 30, 40)')
  })

  test('editor: workbench classifies .altml/.altss/.alts and wxml LSP answers on .altml', async () => {
    await applyInEditorLayoutPreset(workbench)
    const status = await attachWorkbenchAndWaitReady(app)
    expect(status, 'workbench must reach a ready status').toMatch(/workbench-ready|exthost-alive/)

    const probe = await pollUntil(
      () => runInWorkbench<{
        status: string | null
        altml?: string; altss?: string; alts?: string; tagSample?: string[]
      }>(app, EDITOR_PROBE).catch(() => ({ status: null })),
      (result) => typeof result.altml === 'string',
      90_000, 1500,
    )

    expect(probe.altml, '.altml must classify as wxml (drives highlighting + wxml LSP)').toBe('wxml')
    expect(probe.altss, '.altss must classify as css').toBe('css')
    expect(probe.alts, '.alts must classify as javascript').toBe('javascript')

    const tags = probe.tagSample ?? []
    expect(
      tags.includes('view') || tags.includes('scroll-view'),
      `wxml completion must answer on the .altml buffer (LSP via languageId); got=${JSON.stringify(tags)}`,
    ).toBe(true)
  })
})
