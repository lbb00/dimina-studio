import { test, expect, _electron, type ElectronApplication } from '@playwright/test'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  closeDevicePicker,
  evalInDevicePicker,
  evalInPopover,
  findMainWindow,
  openDevicePicker,
  openProjectInUI,
  ipcInvoke,
  pollUntil,
  waitForEditorReady,
  waitForSimulatorWebview,
  waitSimulatorReady,
} from './helpers'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = path.join(root, 'e2e/fixtures/tabbar-app')

async function resizeWindow(app: ElectronApplication, entry: string, width: number, height: number) {
  const size = await app.evaluate(({ BrowserWindow }, request) => {
    const win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes(request.entry))
    if (!win) throw new Error(`Window not found: ${request.entry}`)
    win.setSize(request.width, request.height)
    return { outer: win.getSize(), content: win.getContentSize() }
  }, { entry, width, height })
  expect(size.outer).toEqual([width, height])
  return size.content
}

test('small native windows retain reachable project controls and device selection', async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'dimina-small-screen-'))
  const app = await _electron.launch({
    args: [path.join(root, 'e2e/electron-entry.js'), 'auto', '--auto-port', '0', `--user-data-dir=${profile}`],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DIMINA_NATIVE_HOST: '1',
      DIMINA_DEVTOOLS_DATA_DIR: profile,
      DIMINA_E2E_USER_DATA_DIR: profile,
    },
  })

  try {
    const main = await findMainWindow(app)
    const mainViewport = await resizeWindow(app, 'entries/main/', 800, 560)
    await expect.poll(() => main.evaluate(() => [innerWidth, innerHeight])).toEqual(mainViewport)

    const create = main.getByRole('button', { name: '新建小程序' })
    await create.scrollIntoViewIfNeeded()
    await create.click()
    const createOpen = await pollUntil(
      () => app.evaluate(({ webContents }) => webContents.getAllWebContents().some((wc) => (
        wc.getURL().includes('entries/project-create-dialog') && !wc.isLoading()
      ))),
      Boolean,
      15_000,
      200,
    )
    expect(createOpen).toBe(true)
    const createPage = await pollUntil(
      () => Promise.resolve(app.windows().find(page => page.url().includes('entries/project-create-dialog'))),
      page => !!page, 15_000,
    )
    const createDialog = createPage!.getByRole('dialog')
    await createDialog.waitFor()
    await createPage!.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)))
    const initial = (await createDialog.boundingBox())!
    await createPage!.mouse.move(initial.x + initial.width - 2, initial.y + initial.height / 2)
    await createPage!.mouse.down()
    await createPage!.mouse.move(initial.x + initial.width + 80, initial.y + initial.height / 2, { steps: 8 })
    await createPage!.mouse.up()
    await expect.poll(async () => (await createDialog.boundingBox())!.width).toBeGreaterThan(initial.width + 50)
    const smallViewport = await resizeWindow(app, 'entries/main/', 640, 480)
    await expect.poll(async () => {
      const box = (await createDialog.boundingBox())!
      return box.x + box.width <= smallViewport[0]! - 16 && box.y + box.height <= smallViewport[1]! - 16
    }).toBe(true)
    const cancelled = await app.evaluate(async ({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('entries/project-create-dialog'))
      return wc?.executeJavaScript(`(() => {
        const cancel = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === '取消')
        cancel?.scrollIntoView({ block: 'center' }); cancel?.click(); return !!cancel
      })()`)
    })
    expect(cancelled).toBe(true)
    await create.click()
    await createDialog.waitFor()
    await createPage!.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)))
    await expect.poll(async () => (await createDialog.boundingBox())!.width).toBeLessThanOrEqual(initial.width + 1)
    await createPage!.getByRole('button', { name: '取消', exact: true }).click()

    const workbench = await openProjectInUI(app, fixture, { waitMs: 30_000 })
    const workbenchViewport = await resizeWindow(app, 'entries/workbench', 800, 560)
    await expect.poll(() => workbench.evaluate(() => [innerWidth, innerHeight])).toEqual(workbenchViewport)
    await waitForSimulatorWebview(app)
    await waitSimulatorReady(app)
    await waitForEditorReady(workbench)

    await openDevicePicker(workbench, app)
    const picker = await evalInDevicePicker<{
      options: number
      portrait: boolean
      dialog: { right: number, bottom: number, viewport: [number, number] } | null
    }>(app, `(async () => {
      await Promise.allSettled(document.getAnimations().map((a) => a.finished))
      const dialog = document.querySelector('[role="dialog"]')
      const r = dialog?.getBoundingClientRect()
      return {
        options: document.querySelectorAll('[role="option"]').length,
        portrait: document.body.innerText.includes('仅支持竖屏'),
        dialog: r && { right: r.right, bottom: r.bottom, viewport: [innerWidth, innerHeight] },
      }
    })()`)
    expect(picker.options).toBeGreaterThan(0)
    expect(picker.portrait).toBe(true)
    expect(picker.dialog?.right).toBeLessThanOrEqual(picker.dialog!.viewport[0])
    expect(picker.dialog?.bottom).toBeLessThanOrEqual(picker.dialog!.viewport[1])
    const pickerPage = app.windows().find(page => page.url().includes('entries/device-picker'))!
    await pickerPage.getByPlaceholder('搜索机型').fill('iPhone 16')
    await pickerPage.getByRole('option', { name: 'iPhone 16', exact: true }).click()
    await expect(workbench.getByRole('button', { name: 'iPhone 16', exact: true })).toBeVisible()
    await openDevicePicker(workbench, app)
    expect(await evalInDevicePicker(app, `document.querySelectorAll('[role="option"]').length`)).toBeGreaterThan(0)
    expect(await evalInDevicePicker(app, `document.querySelector('[data-current="true"]')?.getAttribute('aria-label')`)).toBe('iPhone 16')
    await closeDevicePicker(app)

    const compactViewport = await resizeWindow(app, 'entries/workbench', 640, 480)
    await expect.poll(() => workbench.evaluate(() => [innerWidth, innerHeight])).toEqual(compactViewport)
    const settings = workbench.getByRole('button', { name: '设置' })
    await settings.scrollIntoViewIfNeeded()
    const box = await settings.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x + box!.width).toBeLessThanOrEqual(640)
    await workbench.getByRole('button', { name: '隐藏模拟器' }).click()
    await workbench.getByRole('button', { name: '显示模拟器' }).click()
    const expandedViewport = await resizeWindow(app, 'entries/workbench', 1024, 640)
    await expect.poll(() => workbench.evaluate(() => [innerWidth, innerHeight])).toEqual(expandedViewport)
    await openDevicePicker(workbench, app)
    const expanded = await evalInDevicePicker<{ right: number, bottom: number }>(app, `(() => {
      const rect = document.querySelector('[role="dialog"]').getBoundingClientRect();
      return { right: rect.right, bottom: rect.bottom };
    })()`)
    expect(expanded.right).toBeLessThanOrEqual(expandedViewport[0]!)
    expect(expanded.bottom).toBeLessThanOrEqual(expandedViewport[1]!)
    await closeDevicePicker(app)
  } finally {
    await app.close().catch(() => {})
    await fs.rm(profile, { recursive: true, force: true })
  }
})

test('the last compile menu action remains reachable with many modes in a small window', async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'dimina-small-compile-'))
  const project = path.join(profile, 'project')
  await fs.cp(fixture, project, { recursive: true })
  const app = await _electron.launch({
    args: [path.join(root, 'e2e/electron-entry.js'), `--user-data-dir=${profile}`],
    env: { ...process.env, NODE_ENV: 'test', DIMINA_NATIVE_HOST: '1', DIMINA_DEVTOOLS_DATA_DIR: profile, DIMINA_E2E_USER_DATA_DIR: profile },
  })
  try {
    const workbench = await openProjectInUI(app, project, { waitMs: 30_000 })
    await resizeWindow(app, 'entries/workbench', 640, 480)
    await expect(workbench.getByTestId('compile-mode-button')).toBeEnabled()
    for (let index = 0; index < 12; index++) {
      await ipcInvoke(workbench, 'popover:apply', {
        command: { type: 'add', mode: { name: `模式${index}`, pathName: 'pages/home/home', query: '', scene: null } },
      })
    }
    await workbench.getByTestId('compile-mode-button').click()
    const actions = await evalInPopover<Array<{ bottom: number, viewportHeight: number }>>(app, `(() => {
      return [...document.querySelectorAll('[role="menu"] button')]
        .filter(button => button.textContent?.includes('新建') || button.textContent?.trim() === '添加编译模式')
        .map(button => {
          button.scrollIntoView({ block: 'nearest' });
          return { bottom: button.getBoundingClientRect().bottom, viewportHeight: innerHeight };
        });
    })()`)
    expect(actions).toHaveLength(2)
    for (const action of actions) expect(action.bottom).toBeLessThanOrEqual(action.viewportHeight)
    const opened = await evalInPopover<boolean>(app, `(() => {
      const button = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '添加编译模式');
      button?.scrollIntoView({ block: 'nearest' }); button?.click(); return !!button;
    })()`)
    expect(opened).toBe(true)
    await pollUntil(() => evalInPopover(app, `document.querySelector('[role="dialog"]')?.textContent`),
      text => typeof text === 'string' && text.includes('添加编译模式'), 10_000)
    await evalInPopover(app, `(() => {
      const button = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '取消');
      button?.scrollIntoView({ block: 'nearest' }); button?.click();
    })()`)
  } finally {
    await app.close().catch(() => {})
    await fs.rm(profile, { recursive: true, force: true })
  }
})
