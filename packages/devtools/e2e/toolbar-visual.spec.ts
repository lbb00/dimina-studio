import { test, expect } from './fixtures'
import type { Locator } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEMO_APP_DIR,
  closeProject,
  evalInWebContentsByUrl,
  ipcInvoke,
  openProjectInUI,
  pollUntil,
  waitForEditorReady,
  waitForSimulatorWebview,
} from './helpers'
import { WorkbenchSettingsChannel } from '../src/shared/ipc-channels'

function isDarkColor(color: string): boolean {
  const oklchLightness = color.match(/^oklch\(([\d.]+)/)?.[1]
  if (oklchLightness !== undefined) return Number(oklchLightness) < 0.5
  const sum = color.match(/[\d.]+/g)?.slice(0, 3).map(Number)
    .reduce((total, channel) => total + channel, 0) ?? 0
  return sum < 384
}

async function allWorkbenchSurfacesMatchTheme(
  electronApp: Parameters<typeof openProjectInUI>[0],
  workbench: Awaited<ReturnType<typeof openProjectInUI>>,
  isDark: boolean,
): Promise<boolean> {
  const mainColor = await workbench.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const childColors = await electronApp.evaluate(async ({ BrowserWindow }, url) => {
    const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL() === url)
    if (!win) return []
    const visible = win.contentView.children.flatMap((candidate) => {
      const view = candidate as unknown as {
        webContents?: Electron.WebContents
        getBounds(): { width: number, height: number }
      }
      const bounds = view.getBounds()
      return view.webContents && !view.webContents.isDestroyed() && bounds.width > 0 && bounds.height > 0
        ? [view.webContents]
        : []
    })
    return Promise.all(visible.map(wc => wc.executeJavaScript(`(() => {
      const node = document.querySelector('.monaco-workbench')
        || document.querySelector('.device-shell-root')
        || document.body
      return getComputedStyle(node).backgroundColor
    })()`)))
  }, workbench.url())
  const colors = [mainColor, ...childColors]
  lastObservedSurfaceColors = colors.map(String)
  return colors.length >= 3 && colors.every(color => isDarkColor(String(color)) === isDark)
}

let lastObservedSurfaceColors: string[] = []

type MarkerMeasurement = {
  content: string
  width: number
  height: number
  markerColor: string
  activeBackground: string
  contrast: number
}

async function measureActiveMarker(locator: Locator): Promise<MarkerMeasurement> {
  return locator.evaluate((node) => {
    const toRgba = (color: string): [number, number, number, number] => {
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Could not create a canvas color probe')
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
      return [red, green, blue, alpha / 255]
    }
    const luminance = (rgb: [number, number, number]) => rgb.reduce((sum, channel, index) => {
      const normalized = channel / 255
      const linear = normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
      return sum + linear * [0.2126, 0.7152, 0.0722][index]
    }, 0)
    const contrast = (first: [number, number, number], second: [number, number, number]) => {
      const firstLuminance = luminance(first)
      const secondLuminance = luminance(second)
      return (Math.max(firstLuminance, secondLuminance) + 0.05) / (Math.min(firstLuminance, secondLuminance) + 0.05)
    }
    const markerStyle = getComputedStyle(node, '::after')
    const activeStyle = getComputedStyle(node)
    const marker = toRgba(markerStyle.backgroundColor)
    marker[3] *= Number(markerStyle.opacity)
    const active = toRgba(activeStyle.backgroundColor)
    const composite: [number, number, number] = [0, 1, 2].map((channel) =>
      marker[channel] * marker[3] + active[channel] * (1 - marker[3]),
    ) as [number, number, number]
    return {
      content: markerStyle.content,
      width: Number.parseFloat(markerStyle.width) || 0,
      height: Number.parseFloat(markerStyle.height) || 0,
      markerColor: markerStyle.backgroundColor,
      activeBackground: activeStyle.backgroundColor,
      contrast: contrast(composite, active.slice(0, 3) as [number, number, number]),
    }
  })
}

async function measurePopoverMarker(
  electronApp: Parameters<typeof openProjectInUI>[0],
  selector: string,
): Promise<MarkerMeasurement> {
  return evalInWebContentsByUrl(electronApp, 'entries/popover', `(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    if (!node) throw new Error('Missing popover marker target: ' + ${JSON.stringify(selector)})
    const toRgba = (color) => {
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Could not create a canvas color probe')
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
      return [red, green, blue, alpha / 255]
    }
    const luminance = (rgb) => rgb.reduce((sum, channel, index) => {
      const normalized = channel / 255
      const linear = normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
      return sum + linear * [0.2126, 0.7152, 0.0722][index]
    }, 0)
    const contrast = (first, second) => {
      const firstLuminance = luminance(first)
      const secondLuminance = luminance(second)
      return (Math.max(firstLuminance, secondLuminance) + 0.05) / (Math.min(firstLuminance, secondLuminance) + 0.05)
    }
    const markerStyle = getComputedStyle(node, '::after')
    const activeStyle = getComputedStyle(node)
    const marker = toRgba(markerStyle.backgroundColor)
    marker[3] *= Number(markerStyle.opacity)
    const active = toRgba(activeStyle.backgroundColor)
    const composite = [0, 1, 2].map((channel) => marker[channel] * marker[3] + active[channel] * (1 - marker[3]))
    return {
      content: markerStyle.content,
      width: Number.parseFloat(markerStyle.width) || 0,
      height: Number.parseFloat(markerStyle.height) || 0,
      markerColor: markerStyle.backgroundColor,
      activeBackground: activeStyle.backgroundColor,
      contrast: contrast(composite, active.slice(0, 3)),
    }
  })()`)
}

/**
 * Visual capture of the refactored project toolbar after the right-pane
 * tab switcher (DevTools/WXML/AppData/Storage) was removed in favour of
 * BottomDebugPanel. Verifies that:
 *
 *   1. The toolbar no longer renders any [role="tab"] inside the header
 *      band — the only tablist on the page is the bottom debug bar.
 *   2. The compile-mode dropdown trigger ("普通编译 ▾") is present.
 *   3. The section visibility toggle group is present.
 *
 * Screenshot is written next to packages/devtools/test-results/ so the
 * file location is stable regardless of which cwd Playwright is launched
 * from.
 */
test('toolbar: refactored visual layout (no right-pane tabs, compile-mode dropdown, pane toggle)', async ({ electronApp }) => {
  // The workbench window only exists once the project is open, so it is taken
  // from `openProjectInUI`'s return value rather than the `workbench` fixture
  // (which resolves before the test body runs and would time out waiting for a
  // window nothing has asked for yet).
  const workbench = await openProjectInUI(electronApp, DEMO_APP_DIR)
  await waitForEditorReady(workbench)

  // 1. The toolbar header band must not host any tab switcher: the old
  //    right-pane DevTools/WXML/AppData/Storage tabs are gone. Every remaining
  //    `[role="tab"]` is a DOCK tab and therefore lives inside a
  //    `[data-deck-group]`; none stray into the toolbar/header.
  const stragglingTabs = await workbench.$$eval(
    '[role="tab"]',
    (els) =>
      els
        .filter((el) => !el.closest('[data-deck-group]'))
        .map((el) => el.textContent?.trim() ?? ''),
  )
  expect(stragglingTabs, 'no [role="tab"] should live outside the dock (the toolbar has no tab switcher)').toEqual([])

  // The dock tablist is EXACTLY the five debug panels (simulator + editor are
  // tabless structural panels) — assert the precise set so a stray tab can't slip
  // back in unnoticed.
  const dockTabIds = await workbench.$$eval('[data-deck-tab]', (els) =>
    els.map((el) => el.getAttribute('data-deck-tab')),
  )
  expect([...dockTabIds].sort(), 'the dock tablist must be exactly the five debug tabs').toEqual(
    ['appdata', 'compile', 'console', 'storage', 'wxml'],
  )

  // 2. Compile-mode dropdown trigger exists in the toolbar.
  const compileBtn = workbench.getByRole('button', { name: /普通编译/ })
  await expect(compileBtn).toBeVisible()

  // 3. Section visibility toggles live in a labelled toolbar group.
  const visibilityGroup = workbench.getByRole('group', { name: '面板可见性' })
  await expect(visibilityGroup).toBeVisible()
  await expect(visibilityGroup.getByRole('button', { name: /^(隐藏|显示)模拟器$/ })).toBeVisible()
  await expect(visibilityGroup.getByRole('button', { name: /^(隐藏|显示)编辑器$/ })).toBeVisible()
  // The debug region toggle is decoupled from each panel's per-tab `closable`
  // capability: even though the debug panels are `closable:false` (no per-tab ×),
  // the region toggle still hides/shows the whole region as a unit. With the
  // region visible at startup the toggle reads "隐藏调试器"; it is only disabled
  // when debug is the LAST visible region (not the case in the default layout).
  const debugToggle = visibilityGroup.getByRole('button', { name: /^(隐藏|显示)调试器$/ })
  await expect(debugToggle).toBeVisible()

  // Toolbar controls need their own interaction surfaces: the generic muted
  // color is the same as the light toolbar chrome, so its ghost hover is
  // invisible here. Verify the settled hover paint differs from the row.
  const alignmentToggle = workbench.getByTestId('layout-toolbar-alignment-toggle')
  const toolbarColor = await alignmentToggle.evaluate((node) =>
    getComputedStyle(node.closest('.bg-muted')!).backgroundColor,
  )
  await alignmentToggle.hover()
  await expect.poll(() => alignmentToggle.evaluate((node) =>
    getComputedStyle(node).backgroundColor,
  )).not.toBe(toolbarColor)
  await workbench.mouse.move(1, 1)

  // Screenshot — resolve test-results relative to THIS spec file so the
  // output lands inside packages/devtools/test-results regardless of cwd.
  const here = path.dirname(fileURLToPath(import.meta.url))
  const outDir = path.resolve(here, '..', 'test-results')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  await workbench.screenshot({ path: path.join(outDir, 'toolbar-final.png') })
})

test('toolbar and segment active markers are visible only on the selected control', async ({ electronApp }) => {
  const workbench = await openProjectInUI(electronApp, DEMO_APP_DIR)
  await waitForEditorReady(workbench)

  const activeToolbarId = await workbench.locator('[data-testid^="layout-toolbar-devtools-"][data-active="true"]').first().getAttribute('data-testid')
  const inactiveToolbarId = await workbench.locator('[data-testid^="layout-toolbar-devtools-"][data-active="false"]').first().getAttribute('data-testid')
  if (!activeToolbarId || !inactiveToolbarId) throw new Error('Toolbar active/inactive controls were not rendered')
  const activeToolbar = workbench.getByTestId(activeToolbarId)
  const inactiveToolbar = workbench.getByTestId(inactiveToolbarId)
  await expect(activeToolbar).toBeVisible()
  await expect(inactiveToolbar).toBeVisible()

  const activeToolbarMarker = await measureActiveMarker(activeToolbar)
  console.log('TOOLBAR_ACTIVE_MARKER', JSON.stringify(activeToolbarMarker))
  expect(activeToolbarMarker.content).not.toBe('none')
  expect(activeToolbarMarker.width).toBeGreaterThan(0)
  expect(activeToolbarMarker.height).toBeGreaterThan(0)
  expect(activeToolbarMarker.contrast).toBeGreaterThanOrEqual(3)

  const inactiveToolbarMarker = await measureActiveMarker(inactiveToolbar)
  expect(inactiveToolbarMarker.content).toBe('none')

  await inactiveToolbar.click()
  await expect(inactiveToolbar).toHaveAttribute('data-active', 'true')
  await expect(activeToolbar).toHaveAttribute('data-active', 'false')
  await expect.poll(async () => (await measureActiveMarker(inactiveToolbar)).activeBackground).toMatch(/^oklch\(/)
  const movedToolbarMarker = await measureActiveMarker(inactiveToolbar)
  console.log('TOOLBAR_MOVED_MARKER', JSON.stringify(movedToolbarMarker))
  expect(movedToolbarMarker.content).not.toBe('none')
  expect(movedToolbarMarker.contrast).toBeGreaterThanOrEqual(3)
  expect((await measureActiveMarker(activeToolbar)).content).toBe('none')

  await workbench.getByTestId('compile-mode-button').click()
  await pollUntil(
    () => evalInWebContentsByUrl<boolean>(electronApp, 'entries/popover', `Boolean(document.querySelector('[role="menu"][aria-label="编译模式"]'))`),
    (visible) => visible,
    10_000,
  )
  await evalInWebContentsByUrl(electronApp, 'entries/popover', `(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === '添加编译模式')
    if (!button) throw new Error('Missing add compile mode button')
    button.click()
  })()`)
  await pollUntil(
    () => evalInWebContentsByUrl<boolean>(electronApp, 'entries/popover', `Boolean(document.querySelector('[role="dialog"] [role="tab"]'))`),
    (visible) => visible,
    10_000,
  )

  const rowsMarker = await measurePopoverMarker(electronApp, '[role="dialog"] [role="tab"][data-state="active"]')
  console.log('SEGMENT_ROWS_MARKER', JSON.stringify(rowsMarker))
  expect(rowsMarker.content).not.toBe('none')
  expect(rowsMarker.width).toBeGreaterThan(0)
  expect(rowsMarker.height).toBeGreaterThan(0)
  expect(rowsMarker.contrast).toBeGreaterThanOrEqual(3)
  expect((await measurePopoverMarker(electronApp, '[role="dialog"] [role="tab"]:not([data-state="active"])')).content).toBe('none')

  await evalInWebContentsByUrl(electronApp, 'entries/popover', `(() => {
    const tab = [...document.querySelectorAll('[role="dialog"] [role="tab"]')].find((node) => node.textContent?.trim() === '原始串')
    if (!tab) throw new Error('Missing raw params tab')
    tab.click()
  })()`)
  await pollUntil(
    () => evalInWebContentsByUrl<boolean>(electronApp, 'entries/popover', `Boolean(document.querySelector('[role="dialog"] [role="tab"][data-state="active"]')?.textContent?.trim() === '原始串')`),
    (visible) => visible,
    10_000,
  )
  const rawMarker = await measurePopoverMarker(electronApp, '[role="dialog"] [role="tab"][data-state="active"]')
  console.log('SEGMENT_RAW_MARKER', JSON.stringify(rawMarker))
  expect(rawMarker.content).not.toBe('none')
  expect(rawMarker.contrast).toBeGreaterThanOrEqual(3)
  expect((await measurePopoverMarker(electronApp, '[role="dialog"] [role="tab"]:not([data-state="active"])')).content).toBe('none')
})

test('toolbar: native tooltip measures content and survives a second hover', async ({ electronApp }) => {
  const workbench = await openProjectInUI(electronApp, DEMO_APP_DIR)
  await waitForEditorReady(workbench)

  // The toolbar buttons under test ('重新编译'/'设置') live in the workbench
  // window's own renderer — the tooltip WCV attaches there too, so the
  // measured surface must be found on `entries/workbench`, not the project
  // list's `entries/main`.
  const surfaceState = () => electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes('entries/workbench'),
    )
    if (!win) return null
    for (const child of win.contentView.children) {
      const view = child as unknown as {
        webContents?: { getURL(): string }
        getBounds(): { x: number; y: number; width: number; height: number }
      }
      if (view.webContents?.getURL().includes('entries/tooltip')) return view.getBounds()
    }
    return null
  })

  await workbench.getByRole('button', { name: '重新编译' }).hover()
  const firstText = await pollUntil(
    () => evalInWebContentsByUrl<string>(electronApp, 'entries/tooltip', 'document.body.innerText'),
    (text) => text.trim() === '重新编译',
    10_000,
  )
  const firstBounds = await pollUntil(surfaceState, (bounds) => bounds !== null, 10_000)
  expect(firstBounds, 'the measured tooltip must attach to the workbench window').not.toBeNull()
  expect(firstText.trim()).toBe('重新编译')
  expect(firstBounds!.width).toBeGreaterThan(20)
  expect(firstBounds!.width).toBeLessThan(160)

  await workbench.getByRole('button', { name: '设置' }).hover()
  const secondText = await pollUntil(
    () => evalInWebContentsByUrl<string>(electronApp, 'entries/tooltip', 'document.body.innerText'),
    (text) => text.trim() === '设置',
    10_000,
  )
  const secondBounds = await pollUntil(surfaceState, (bounds) => bounds !== null, 10_000)
  expect(secondText.trim()).toBe('设置')
  expect(secondBounds!.width).toBeLessThan(firstBounds!.width)

  await workbench.mouse.move(1, 1)
  await pollUntil(surfaceState, (bounds) => bounds === null, 10_000)
})

test('theme stays aligned when a project opens after the selected theme, then survives a second switch', async ({ electronApp, mainWindow }) => {
  // Set the theme before any project-owned BrowserWindow/WebContentsView exists.
  // Re-applying the same value after the project opens emits no nativeTheme
  // `updated` event, so the first assertion proves every newly-created surface
  // receives an initial theme instead of only reacting to later switches.
  await ipcInvoke(mainWindow, WorkbenchSettingsChannel.SetTheme, 'dark')
  const workbench = await openProjectInUI(electronApp, DEMO_APP_DIR)
  await waitForEditorReady(workbench)
  await waitForSimulatorWebview(electronApp)

  await ipcInvoke(workbench, WorkbenchSettingsChannel.SetTheme, 'dark')
  try {
    await expect.poll(() => allWorkbenchSurfacesMatchTheme(electronApp, workbench, true)).toBe(true)
  } catch (error) {
    throw new Error(`Dark surfaces did not converge: ${JSON.stringify(lastObservedSurfaceColors)}`, { cause: error })
  }

  await ipcInvoke(workbench, WorkbenchSettingsChannel.SetTheme, 'light')
  try {
    await expect.poll(() => allWorkbenchSurfacesMatchTheme(electronApp, workbench, false)).toBe(true)
  } catch (error) {
    throw new Error(`Light surfaces did not converge: ${JSON.stringify(lastObservedSurfaceColors)}`, { cause: error })
  }
})

test.afterEach(async ({ electronApp }) => {
  await closeProject(electronApp)
})
