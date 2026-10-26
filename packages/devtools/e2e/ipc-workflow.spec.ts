import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './fixtures'
import { DEMO_APP_DIR, RENDER_GUEST_URL_MARKER, closeProject, findWorkbenchWindow, ipcInvoke, addProject } from './helpers'
import { ProjectsChannel, ProjectChannel } from '../src/shared/ipc-channels'

test.describe('IPC + Project Workflow', () => {
  // These tests drive `ProjectChannel.Open/Close` directly (not through the
  // project-card click), so they never spawn a real workbench BrowserWindow —
  // the session lives in the calling (list) window's own WorkbenchContext.
  // Close it the same way; `closeProject(electronApp)` only tears down real
  // workbench windows and would be a no-op here. It's still called as a
  // belt-and-suspenders in case a later test starts opening through the UI.
  test.afterEach(async ({ mainWindow, electronApp }) => {
    await ipcInvoke(mainWindow, ProjectChannel.Close).catch(() => {})
    await closeProject(electronApp).catch(() => {})
    await ipcInvoke(mainWindow, ProjectsChannel.Remove, DEMO_APP_DIR).catch(() => {})
  })

  test('projects:list returns an array', async ({ mainWindow }) => {
    const projects = await ipcInvoke(mainWindow, ProjectsChannel.List)
    expect(Array.isArray(projects)).toBe(true)
  })

  test('project:getPages returns page list for demo app', async ({ mainWindow }) => {
    const result = await ipcInvoke<{ pages: string[]; entryPagePath: string }>(
      mainWindow,
      ProjectChannel.GetPages,
      DEMO_APP_DIR
    )

    expect(result).toBeTruthy()
    expect(typeof result).toBe('object')
    expect(Array.isArray(result.pages)).toBe(true)
    expect(typeof result.entryPagePath).toBe('string')
  })

  test('project:getCompileConfig returns config for demo app', async ({ mainWindow }) => {
    await addProject(mainWindow, DEMO_APP_DIR)

    const config = await ipcInvoke(mainWindow, ProjectChannel.GetCompileConfig, DEMO_APP_DIR)

    // Config may be null/undefined for a fresh project or an object
    expect(config === null || config === undefined || typeof config === 'object').toBe(true)
  })

  test('projects:add and projects:remove round-trip', async ({ mainWindow }) => {
    await addProject(mainWindow, DEMO_APP_DIR)

    let projects = await ipcInvoke<Array<{ path: string }>>(mainWindow, ProjectsChannel.List)
    expect(projects.some((p) => p.path === DEMO_APP_DIR)).toBe(true)

    await ipcInvoke(mainWindow, ProjectsChannel.Remove, DEMO_APP_DIR)

    projects = await ipcInvoke<Array<{ path: string }>>(mainWindow, ProjectsChannel.List)
    expect(projects.some((p) => p.path === DEMO_APP_DIR)).toBe(false)
  })

  test('project:open and project:close lifecycle', async ({ mainWindow }) => {
    await addProject(mainWindow, DEMO_APP_DIR)

    const openResult = await ipcInvoke(mainWindow, ProjectChannel.Open, DEMO_APP_DIR)
    expect(openResult).toBeTruthy()
    expect(typeof openResult).toBe('object')

    // Close should not throw
    await ipcInvoke(mainWindow, ProjectChannel.Close)
  })

  test('can open and compile a project', async ({ mainWindow }) => {
    await addProject(mainWindow, DEMO_APP_DIR)

    const result = await ipcInvoke<{ success: boolean }>(mainWindow, ProjectChannel.Open, DEMO_APP_DIR)
    expect(result).toBeTruthy()
    expect(typeof result).toBe('object')

    // Close the project so teardown doesn't hang
    await ipcInvoke(mainWindow, ProjectChannel.Close)
  })
})


const IMPORT_RENDER_MARKER = 'IMPORT_WORKBENCH_RENDERED'

function createImportProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina 导入 工作台 '))
  fs.mkdirSync(path.join(projectDir, 'pages', 'index'), { recursive: true })
  const files: Record<string, string> = {
    'app.js': 'App({})',
    'app.json': JSON.stringify({ pages: ['pages/index/index'] }),
    'project.config.json': JSON.stringify({ appid: 'dmlocalpreview', projectname: '导入 空格 项目' }),
    'pages/index/index.js': 'Page({})',
    'pages/index/index.json': '{}',
    'pages/index/index.wxml': `<view>${IMPORT_RENDER_MARKER}</view>`,
    'pages/index/index.wxss': '',
  }
  for (const [relativePath, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(projectDir, relativePath), contents)
  }
  return projectDir
}

async function renderedMarkerExists(
  electronApp: import('@playwright/test').ElectronApplication,
): Promise<boolean> {
  return electronApp.evaluate(async ({ webContents }, payload) => {
    const frames = webContents.getAllWebContents().filter((contents) =>
      !contents.isDestroyed() && contents.getURL().includes(payload.frameMarker),
    )
    for (const frame of frames) {
      try {
        if (await frame.executeJavaScript(`document.body?.innerText.includes(${JSON.stringify(payload.marker)})`)) {
          return true
        }
      } catch {
        // A previous page frame may be in the middle of close/reload. Keep
        // checking the remaining live frames; the caller polls readiness.
      }
    }
    return false
  }, { marker: IMPORT_RENDER_MARKER, frameMarker: RENDER_GUEST_URL_MARKER })
}

async function captureRenderedMarkerPage(
  electronApp: import('@playwright/test').ElectronApplication,
): Promise<{ png: string; rect: { width: number; height: number }; ancestorsVisible: boolean } | { error: string }> {
  return electronApp.evaluate(async ({ webContents }, payload) => {
    const frames = webContents.getAllWebContents().filter((contents) =>
      !contents.isDestroyed() && contents.getURL().includes(payload.frameMarker),
    )
    for (const frame of frames) {
      try {
        const state = await frame.executeJavaScript(`(() => {
          const marker = ${JSON.stringify(payload.marker)}
          const findText = root => {
            const textWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
            for (let text = textWalker.nextNode(); text; text = textWalker.nextNode()) {
              if (text.textContent?.includes(marker)) return text
            }
            const elementWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
            for (let node = elementWalker.nextNode(); node; node = elementWalker.nextNode()) {
              const nested = node.shadowRoot && findText(node.shadowRoot)
              if (nested) return nested
            }
            return null
          }
          const text = findText(document.body)
          const element = text?.parentElement
          if (!element) return null
          const rect = element.getBoundingClientRect()
          let ancestorsVisible = true
          for (let current = element; current;) {
            const style = getComputedStyle(current)
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
              ancestorsVisible = false
              break
            }
            const root = current.getRootNode()
            current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
          }
          return { rect: { width: rect.width, height: rect.height }, ancestorsVisible }
        })()`)
        if (!state) continue
        const png = (await frame.capturePage()).toPNG().toString('base64')
        return { ...state, png }
      } catch (error) {
        return { error: error instanceof Error ? error.stack ?? error.message : String(error) }
      }
    }
    throw new Error('No live render-host frame contains the imported page marker')
  }, { marker: IMPORT_RENDER_MARKER, frameMarker: RENDER_GUEST_URL_MARKER })
}

test.describe('Main import opens a real Workbench window', () => {
  test.setTimeout(180_000)

  let projectDir = ''

  test.afterEach(async ({ electronApp, mainWindow }) => {
    try {
      if (projectDir) await closeProject(electronApp, { projectDir })
    } finally {
      if (projectDir) await ipcInvoke(mainWindow, ProjectsChannel.Remove, projectDir).catch(() => {})
      if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true })
      projectDir = ''
    }
  })

  test('imports a typed Chinese-space directory, renders it, and opens it again after close', async ({ electronApp, mainWindow }, testInfo) => {
    projectDir = createImportProject()

    async function importFromMainAndWaitForRender() {
      await mainWindow.getByRole('button', { name: '导入', exact: true }).click()
      const dialog = mainWindow.getByRole('dialog')
      await dialog.getByLabel('项目目录').fill(projectDir)
      await dialog.getByRole('button', { name: '导入', exact: true }).click()

      const workbench = await findWorkbenchWindow(electronApp, { projectDir, timeoutMs: 60_000 })
      await workbench.waitForLoadState('domcontentloaded')
      await expect(workbench.getByTestId('compile-status-message')).toContainText(/编译完成|刷新完成/, { timeout: 60_000 })
      await expect.poll(() => renderedMarkerExists(electronApp), { timeout: 45_000 }).toBe(true)
      return workbench
    }

    const firstWorkbench = await importFromMainAndWaitForRender()
    await expect.poll(async () => {
      const projects = await ipcInvoke<Array<{ path: string }>>(mainWindow, ProjectsChannel.List)
      return projects.filter((project) => project.path === projectDir).length
    }).toBe(1)

    await closeProject(electronApp, { projectDir })
    await expect.poll(async () => electronApp.windows().filter((win) => win.url().includes(encodeURIComponent(projectDir))).length).toBe(0)
    await expect.poll(() => renderedMarkerExists(electronApp), { timeout: 30_000 }).toBe(false)

    const secondWorkbench = await importFromMainAndWaitForRender()
    await secondWorkbench.screenshot({ path: testInfo.outputPath('c15-import-second-workbench.png') })
    await testInfo.attach('c15-import-second-workbench', {
      path: testInfo.outputPath('c15-import-second-workbench.png'),
      contentType: 'image/png',
    })
    const renderedPage = await captureRenderedMarkerPage(electronApp)
    if ('error' in renderedPage) throw new Error(`render guest capture failed: ${renderedPage.error}`)
    expect(renderedPage.rect.width).toBeGreaterThan(0)
    expect(renderedPage.rect.height).toBeGreaterThan(0)
    expect(renderedPage.ancestorsVisible).toBe(true)
    const renderedPagePath = testInfo.outputPath('c15-import-second-render-guest.png')
    fs.writeFileSync(renderedPagePath, Buffer.from(renderedPage.png, 'base64'))
    await testInfo.attach('c15-import-second-render-guest', {
      path: renderedPagePath,
      contentType: 'image/png',
    })
    expect(firstWorkbench).not.toBe(secondWorkbench)
    await expect.poll(async () => {
      const projects = await ipcInvoke<Array<{ path: string }>>(mainWindow, ProjectsChannel.List)
      return projects.filter((project) => project.path === projectDir).length
    }).toBe(1)
  })
})
