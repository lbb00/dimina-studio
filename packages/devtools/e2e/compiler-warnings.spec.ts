import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { ProjectsChannel } from '../src/shared/ipc-channels'
import { closeProject, findMainWindow, ipcInvoke, openProjectInUI, pollUntil } from './helpers'
import { attachWorkbenchAndWaitReady, runInWorkbench } from './workbench-probe'

interface EditorMarker {
  uri: string
  message: string
  line: number
  column: number
  severity: number
}

const RELATIVE_TEMPLATE = 'pages/index/index.wxml'
const TEMPLATE_WARNING = 'Unsupported or undeclared component: <notatag>'
const __dirname = path.dirname(fileURLToPath(import.meta.url))

function createProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-compiler-warning-'))
  fs.mkdirSync(path.join(root, 'pages/index'), { recursive: true })
  const files: Record<string, string> = {
    'app.js': 'App({})',
    'app.json': JSON.stringify({ pages: ['pages/index/index'] }),
    'project.config.json': JSON.stringify({ appid: 'dmlocalpreview', projectname: 'compiler-warning-e2e' }),
    'pages/index/index.js': 'Page({})',
    'pages/index/index.json': '{}',
    'pages/index/index.wxss': '',
    [RELATIVE_TEMPLATE]: '<view>COMPILER_WARNING_E2E</view>\n<notatag>warning</notatag>',
  }
  for (const [relative, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, relative), content)
  }
  return root
}

function markers(app: ElectronApplication): Promise<EditorMarker[]> {
  return runInWorkbench<EditorMarker[]>(app, `
    window.__WB_PROBE.vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) =>
      diagnostics.filter(diagnostic => diagnostic.source === 'dimina-compiler').map(diagnostic => ({
        uri: uri.toString(), message: diagnostic.message, line: diagnostic.range.start.line,
        column: diagnostic.range.start.character, severity: diagnostic.severity,
      })),
    )
  `)
}

function hasWarning(items: EditorMarker[]): boolean {
  return items.some((item) => item.uri === `file:///workspace/${RELATIVE_TEMPLATE}`
    && item.message === TEMPLATE_WARNING && item.line === 1 && item.severity === 1)
}

async function revealWarningFile(app: ElectronApplication): Promise<void> {
  const opened = await runInWorkbench<boolean>(app, `
    (async () => {
      const probe = window.__WB_PROBE
      const uri = probe.URI.parse('file:///workspace/${RELATIVE_TEMPLATE}')
      const document = await probe.vscode.workspace.openTextDocument(uri)
      await probe.vscode.window.showTextDocument(document)
      return true
    })()
  `)
  expect(opened).toBe(true)
}

async function warningSquiggles(app: ElectronApplication): Promise<number> {
  return runInWorkbench<number>(app, 'document.querySelectorAll(".squiggly-warning").length')
}

test.describe('Compiler warnings reach the embedded editor', () => {
  test.setTimeout(180_000)

  let app: ElectronApplication | undefined
  let projectRoot = ''
  let userData = ''

  test.afterEach(async () => {
    if (app) {
      await closeProject(app, { projectDir: projectRoot }).catch(() => {})
      const main = await findMainWindow(app).catch(() => undefined)
      if (main && projectRoot) await ipcInvoke(main, ProjectsChannel.Remove, projectRoot).catch(() => {})
      await app.close().catch(() => {})
    }
    app = undefined
    if (userData) fs.rmSync(userData, { recursive: true, force: true })
    userData = ''
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true })
    projectRoot = ''
  })

  test('shows, clears, and restores a successful compiler warning in the original WXML editor', async () => {
    projectRoot = createProject()
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-compiler-warning-userdata-'))
    app = await _electron.launch({
      args: [path.resolve(__dirname, 'electron-entry.js'), `--user-data-dir=${userData}`],
      env: { ...process.env, NODE_ENV: 'test', DIMINA_DEVTOOLS_DATA_DIR: userData },
    })
    const main = await findMainWindow(app)
    await main.waitForLoadState('domcontentloaded')
    const workbench = await openProjectInUI(app, projectRoot, { waitMs: 60_000 })
    if (await workbench.getByTestId('layout-toolbar-toggle-editor').getAttribute('aria-label') === '显示编辑器') {
      await workbench.getByTestId('layout-toolbar-toggle-editor').click()
    }
    await expect.poll(() => attachWorkbenchAndWaitReady(app!, 10_000), { timeout: 60_000 })
      .toMatch(/workbench-ready|exthost-alive/)

    const initial = await pollUntil(() => markers(app!), hasWarning, 30_000, 250)
    expect(hasWarning(initial), 'the compiler warning must reach its original editor URI').toBe(true)
    await revealWarningFile(app)
    await expect.poll(() => warningSquiggles(app!), { timeout: 15_000 }).toBeGreaterThan(0)

    fs.writeFileSync(path.join(projectRoot, RELATIVE_TEMPLATE), '<view>COMPILER_WARNING_E2E</view>')
    await expect.poll(() => markers(app!), { timeout: 30_000 }).toEqual([])

    fs.writeFileSync(path.join(projectRoot, RELATIVE_TEMPLATE), '<view>COMPILER_WARNING_E2E</view>\n<notatag>warning</notatag>')
    const reintroduced = await pollUntil(() => markers(app!), hasWarning, 30_000, 250)
    expect(hasWarning(reintroduced), 'the same warning must return after it is reintroduced').toBe(true)
  })
})
