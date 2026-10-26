import { test, expect } from './fixtures'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  DEMO_APP_DIR,
  openProjectInUI,
  closeProject,
  ipcInvoke,
  evalInWebContentsByUrl,
  pollUntil,
} from './helpers'
import { ProjectsChannel, WorkbenchSettingsChannel } from '../src/shared/ipc-channels'

/**
 * UI-driven settings flow. The embedded settings overlay is opened the way a
 * USER opens it — clicking the toolbar's 设置 button — instead of the previous
 * raw `ipcInvoke('settings:setVisible', true)` backdoor, which kept passing
 * even while the overlay was unreachable from the actual UI.
 */
async function openSettingsViaUI(workbench: Page, electronApp: ElectronApplication): Promise<void> {
  const settingsButton = workbench.getByRole('button', { name: '设置' })
  await expect(settingsButton).toBeVisible({ timeout: 15_000 })
  await settingsButton.click()
  // The click is fire-and-forget from Playwright's perspective: it drives
  // invoke('settings:setVisible', true) and main creates the overlay WCV
  // lazily. Wait until the overlay webContents is reachable so callers can
  // immediately evaluate into it without racing its creation.
  await pollUntil(
    () => evalInWebContentsByUrl<number>(electronApp, 'entries/settings', '1'),
    (value) => value === 1,
    10_000,
  )
}

async function openWorkbenchSettingsViaMenu(electronApp: ElectronApplication): Promise<Page> {
  const existing = electronApp.windows().find((page) => page.url().includes('entries/workbench-settings'))
  if (existing && !existing.isClosed()) return existing

  const created = electronApp.waitForEvent('window')
  await electronApp.evaluate(({ Menu }) => {
    const command = Menu.getApplicationMenu()?.items
      .flatMap((item) => item.submenu?.items ?? [])
      .find((item) => item.label === '开发工具设置')
    if (!command?.click) throw new Error('[e2e] 开发工具设置 menu item is missing')
    ;(command.click as () => void)()
  })
  const settings = await created
  await settings.waitForLoadState('domcontentloaded')
  await expect.poll(() => settings.url()).toContain('entries/workbench-settings')
  return settings
}

async function closeWorkbenchSettings(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().includes('entries/workbench-settings'))
      ?.close()
  })
  await expect.poll(() => electronApp.windows().some((page) => page.url().includes('entries/workbench-settings'))).toBe(false)
}

async function readTooltipTheme(page: Page) {
  return page.getByRole('tooltip').evaluate((tooltip) => {
    const content = tooltip.closest('[data-side]')
    if (!content) throw new Error('[e2e] visible tooltip content is missing')
    const probe = document.createElement('div')
    probe.style.cssText = 'position:absolute;visibility:hidden;background:var(--popover);color:var(--popover-foreground)'
    document.body.appendChild(probe)
    const tooltipStyle = getComputedStyle(content)
    const probeStyle = getComputedStyle(probe)
    const colors = {
      background: tooltipStyle.backgroundColor,
      foreground: tooltipStyle.color,
      expectedBackground: probeStyle.backgroundColor,
      expectedForeground: probeStyle.color,
      light: document.documentElement.classList.contains('light'),
      dark: document.documentElement.classList.contains('dark'),
      pointerEvents: tooltipStyle.pointerEvents,
    }
    probe.remove()
    return colors
  })
}

async function auditThemeContrast(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.cssText = 'position:absolute;visibility:hidden'
    document.body.appendChild(probe)
    const resolve = (name: string) => {
      probe.style.color = `var(${name})`
      return getComputedStyle(probe).color
    }
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const pixel = (foreground: string, background: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = background
      context.fillRect(0, 0, 1, 1)
      context.fillStyle = foreground
      context.fillRect(0, 0, 1, 1)
      return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)]
    }
    const luminance = (channels: number[]) => channels
      .map((channel) => channel / 255)
      .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0)
    const ratio = (foreground: string, background: string) => {
      const backgroundColor = resolve(background)
      const values = [
        luminance(pixel(resolve(foreground), backgroundColor)),
        luminance(pixel(backgroundColor, 'white')),
      ].sort((a, b) => b - a)
      return (values[0]! + 0.05) / (values[1]! + 0.05)
    }
    const pairs: Array<[string, string, number]> = [
      ['--foreground', '--background', 4.5],
      ['--card-foreground', '--card', 4.5],
      ['--popover-foreground', '--popover', 4.5],
      ['--primary-foreground', '--primary', 4.5],
      ['--secondary-foreground', '--secondary', 4.5],
      ['--accent-foreground', '--accent', 4.5],
      ['--destructive-foreground', '--destructive', 4.5],
      ['--sidebar-foreground', '--sidebar', 4.5],
      ['--sidebar-primary-foreground', '--sidebar-primary', 4.5],
      ['--success', '--success-soft', 4.5],
      ['--warning', '--warning-soft', 4.5],
      ['--info', '--info-soft', 4.5],
      ['--color-status-error', '--destructive-soft', 4.5],
    ]
    const surfaces = ['--background', '--card', '--popover', '--muted']
    for (const foreground of [
      '--color-code-blue', '--color-code-orange', '--color-code-label',
      '--color-code-number', '--color-code-keyword',
      '--success', '--warning', '--info', '--color-status-error',
    ]) {
      for (const background of surfaces) pairs.push([foreground, background, 4.5])
    }
    for (const background of ['--background', '--card', '--popover']) {
      pairs.push(['--muted-foreground', background, 4.5])
    }
    for (const foreground of ['--input', '--ring', '--scrollbar-thumb']) {
      for (const background of surfaces) pairs.push([foreground, background, 3])
    }
    const results = pairs.map(([foreground, background, minimum]) => ({
      foreground,
      background,
      minimum,
      ratio: ratio(foreground, background),
    }))
    probe.remove()
    return {
      minimum: Math.min(...results.map((result) => result.ratio)),
      failures: results.filter((result) => result.ratio + Number.EPSILON < result.minimum),
    }
  })
}

test.describe('Settings', () => {
  test.beforeEach(async ({ electronApp }) => {
    await openProjectInUI(electronApp, DEMO_APP_DIR)
  })

  test.afterEach(async ({ mainWindow, electronApp }) => {
    await closeProject(electronApp)
    await ipcInvoke(mainWindow, ProjectsChannel.Remove, DEMO_APP_DIR).catch(() => {})
  })

  test('settings view opens from the toolbar 设置 button', async ({ workbench, electronApp }) => {
    await openSettingsViaUI(workbench, electronApp)

    const text = await pollUntil(
      () => evalInWebContentsByUrl<string>(electronApp, 'entries/settings', `document.body.innerText`),
      (value) => value.includes('本地设置') && value.includes('项目配置'),
      10000
    )

    expect(text).toContain('本地设置')
  })

  test('settings view receives current project path', async ({ workbench, electronApp }) => {
    await openSettingsViaUI(workbench, electronApp)
    await evalInWebContentsByUrl(
      electronApp,
      'entries/settings',
      `(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((el) => el.textContent?.includes('项目配置'))
        if (!btn) return false
        btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
        btn.click()
        return true
      })()`
    )

    const text = await pollUntil(
      () => evalInWebContentsByUrl<string>(electronApp, 'entries/settings', `document.body.innerText`),
      (value) => value.includes('项目配置') && value.includes(DEMO_APP_DIR),
      10000
    )

    expect(text).toContain('项目配置')
    expect(text).toContain(DEMO_APP_DIR)
  })

  test('settings inherits the selected theme on first creation and a second open', async ({ workbench, electronApp }) => {
    await ipcInvoke(workbench, WorkbenchSettingsChannel.SetTheme, 'dark')
    await openSettingsViaUI(workbench, electronApp)

    const dark = await evalInWebContentsByUrl<boolean>(
      electronApp,
      'entries/settings',
      `document.documentElement.classList.contains('dark')
        && !document.documentElement.classList.contains('light')`,
    )
    expect(dark).toBe(true)

    await evalInWebContentsByUrl(
      electronApp,
      'entries/settings',
      `document.querySelector('[data-testid="settings-backdrop"]')?.click()`,
    )
    await ipcInvoke(workbench, WorkbenchSettingsChannel.SetTheme, 'light')
    await openSettingsViaUI(workbench, electronApp)

    const light = await evalInWebContentsByUrl<boolean>(
      electronApp,
      'entries/settings',
      `document.documentElement.classList.contains('light')
        && !document.documentElement.classList.contains('dark')`,
    )
    expect(light).toBe(true)
  })

  test('standalone settings help adapts to both themes and remains hoverable and dismissible', async ({ electronApp, mainWindow }) => {
    const compileGuidance = '打开项目时会监听源文件改动并自动重新编译。'
    let lightColors: Awaited<ReturnType<typeof readTooltipTheme>>
    try {
      await ipcInvoke(mainWindow, WorkbenchSettingsChannel.SetTheme, 'light')
      const first = await openWorkbenchSettingsViaMenu(electronApp)
      first.setDefaultTimeout(5_000)
      await first.mouse.move(1, 1)
      await expect(first.locator('[data-side]').filter({ hasText: compileGuidance })).toHaveCount(0)

      await first.getByRole('button', { name: '查看自动编译说明' }).hover()
      await expect(first.locator('[data-side]').filter({ hasText: compileGuidance })).toBeVisible()
      lightColors = await readTooltipTheme(first)
      const lightContrast = await auditThemeContrast(first)
      expect(lightColors).toMatchObject({ light: true, dark: false })
      expect(lightContrast.failures).toEqual([])
      expect(lightColors.background).toBe(lightColors.expectedBackground)
      expect(lightColors.foreground).toBe(lightColors.expectedForeground)
      expect(lightColors.pointerEvents).not.toBe('none')
      const lightTooltip = first.locator('[data-side]').filter({ hasText: compileGuidance })
      await lightTooltip.hover()
      await expect(lightTooltip).toBeVisible()
      await first.keyboard.press('Escape')
      await expect(lightTooltip).toHaveCount(0)
      await first.getByRole('tab', { name: '调试' }).click()
      await expect(first.getByRole('button', { name: '查看启用 DevTools Protocol 说明' })).toBeVisible()

      await closeWorkbenchSettings(electronApp)
      await ipcInvoke(mainWindow, WorkbenchSettingsChannel.SetTheme, 'dark')
      const second = await openWorkbenchSettingsViaMenu(electronApp)
      await second.getByRole('tab', { name: 'MCP' }).click()
      await second.getByRole('button', { name: '查看启用 MCP 服务说明' }).hover()
      await expect(second.locator('[data-side]').filter({ hasText: 'AI 助手可以通过 MCP 连接当前开发工具' })).toBeVisible()
      const darkColors = await readTooltipTheme(second)
      const darkContrast = await auditThemeContrast(second)
      expect(darkColors).toMatchObject({ light: false, dark: true })
      expect(darkContrast.failures).toEqual([])
      expect(darkColors.background).toBe(darkColors.expectedBackground)
      expect(darkColors.foreground).toBe(darkColors.expectedForeground)
      expect(darkColors.pointerEvents).not.toBe('none')
      expect(darkColors.background).not.toBe(lightColors.background)
      expect(darkColors.foreground).not.toBe(lightColors.foreground)
    } finally {
      await closeWorkbenchSettings(electronApp).catch(() => {})
      await ipcInvoke(mainWindow, WorkbenchSettingsChannel.SetTheme, 'system').catch(() => {})
    }
  })
})
