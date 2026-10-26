import { test, expect } from './fixtures'
import { DEMO_APP_DIR, ipcInvoke, addProject, refreshProjectList, selectProjectCategoryInUI, resolveMiniGameAppDir } from './helpers'
import { ProjectsChannel } from '../src/shared/ipc-channels'

const MINI_GAME_DIR = resolveMiniGameAppDir()

type ThemeState = {
  name: string
  rootClass: 'light' | 'dark' | null
  colorScheme: 'light' | 'dark'
}

type IndicatorContrast = {
  indicator: [number, number, number, number]
  activeBackground: [number, number, number, number]
  sidebarBackground: [number, number, number, number]
  composite: [number, number, number]
  contrastToActive: number
  contrastToSidebar: number
}

async function measureIndicatorContrast(
  sidebar: import('@playwright/test').Page,
  label: string,
  rootClass: ThemeState['rootClass'],
): Promise<IndicatorContrast> {
  return sidebar.evaluate(async ({ label, rootClass }) => {
    const root = document.documentElement
    const previousClasses = root.className
    const button = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
    if (!button) throw new Error(`Missing category button for ${label}`)
    const previousTransition = button.style.transition
    button.style.transition = 'none'
    root.classList.remove('light', 'dark')
    if (rootClass) root.classList.add(rootClass)
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const indicator = button?.querySelector<HTMLElement>('[data-active-indicator]')
      const sidebarElement = button?.closest<HTMLElement>('[data-host-sidebar-root]')
      if (!button || !indicator || !sidebarElement) throw new Error(`Missing active indicator for ${label}`)

      const toRgba = (color: string): [number, number, number, number] => {
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Could not create a canvas color probe')
        context.fillStyle = color
        if (!context.fillStyle) throw new Error(`Could not parse color ${color}`)
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
      const indicatorStyle = getComputedStyle(indicator)
      const buttonStyle = getComputedStyle(button)
      const sidebarStyle = getComputedStyle(sidebarElement)
      const indicatorColor = toRgba(indicatorStyle.backgroundColor)
      indicatorColor[3] *= Number(indicatorStyle.opacity)
      const activeBackground = toRgba(buttonStyle.backgroundColor)
      const sidebarBackground = toRgba(sidebarStyle.backgroundColor)
      const composite: [number, number, number] = [0, 1, 2].map((channel) => Math.round(
        indicatorColor[channel] * indicatorColor[3]
        + activeBackground[channel] * (1 - indicatorColor[3]),
      )) as [number, number, number]
      return {
        indicator: indicatorColor,
        activeBackground,
        sidebarBackground,
        composite,
        contrastToActive: contrast(composite, activeBackground.slice(0, 3) as [number, number, number]),
        contrastToSidebar: contrast(composite, sidebarBackground.slice(0, 3) as [number, number, number]),
      }
    } finally {
      button.style.transition = previousTransition
      root.className = previousClasses
    }
  }, { label, rootClass })
}

test.describe('project list: category rail filters by project type', () => {
  test.afterEach(async ({ mainWindow }) => {
    await ipcInvoke(mainWindow, ProjectsChannel.Remove, DEMO_APP_DIR).catch(() => {})
    await ipcInvoke(mainWindow, ProjectsChannel.Remove, MINI_GAME_DIR).catch(() => {})
  })

  test('miniprogram category shows miniprogram projects, hides mini-game projects', async ({ electronApp, mainWindow }) => {
    await addProject(mainWindow, MINI_GAME_DIR)
    await addProject(mainWindow, DEMO_APP_DIR)
    await refreshProjectList(mainWindow)
    // Select explicitly rather than relying on '小程序' being the initial
    // category: the Electron app is worker-scoped, so an earlier spec may have
    // left the rail on 小游戏.
    await selectProjectCategoryInUI(electronApp, 'miniprogram')

    await expect(mainWindow.locator(`[title="${DEMO_APP_DIR}"]`).first()).toBeVisible()
    await expect(mainWindow.locator(`[title="${MINI_GAME_DIR}"]`).first()).toHaveCount(0)
  })

  test('switching to 小游戏 shows mini-game projects, hides miniprogram projects', async ({ electronApp, mainWindow }) => {
    await addProject(mainWindow, DEMO_APP_DIR)
    await addProject(mainWindow, MINI_GAME_DIR)
    await refreshProjectList(mainWindow)

    await selectProjectCategoryInUI(electronApp, 'minigame')

    await expect(mainWindow.locator(`[title="${MINI_GAME_DIR}"]`).first()).toBeVisible()
    await expect(mainWindow.locator(`[title="${DEMO_APP_DIR}"]`).first()).toHaveCount(0)
  })

  test('switching back to 小程序 restores the miniprogram-only view', async ({ electronApp, mainWindow }) => {
    await addProject(mainWindow, DEMO_APP_DIR)
    await addProject(mainWindow, MINI_GAME_DIR)
    await refreshProjectList(mainWindow)

    await selectProjectCategoryInUI(electronApp, 'minigame')
    await expect(mainWindow.locator(`[title="${MINI_GAME_DIR}"]`).first()).toBeVisible()

    await selectProjectCategoryInUI(electronApp, 'miniprogram')
    await expect(mainWindow.locator(`[title="${DEMO_APP_DIR}"]`).first()).toBeVisible()
    await expect(mainWindow.locator(`[title="${MINI_GAME_DIR}"]`).first()).toHaveCount(0)
  })

  test('selected category has a persistent high-contrast indicator that moves with selection', async ({ electronApp }) => {
    const sidebar = electronApp.windows().find((win) => /entries\/host-sidebar-default\//.test(win.url()))
    if (!sidebar) throw new Error('host sidebar window not found')

    await sidebar.waitForSelector('[aria-label="小程序"]')
    const miniprogram = sidebar.locator('[aria-label="小程序"]')
    const minigame = sidebar.locator('[aria-label="小游戏"]')

    await selectProjectCategoryInUI(electronApp, 'miniprogram')
    await expect(miniprogram).toHaveAttribute('aria-pressed', 'true')
    await expect(miniprogram.locator('[data-active-indicator]')).toHaveCount(1)
    await expect(minigame.locator('[data-active-indicator]')).toHaveCount(0)
    const themeStates: ThemeState[] = [
      { name: 'explicit dark', rootClass: 'dark', colorScheme: 'light' },
      { name: 'explicit light', rootClass: 'light', colorScheme: 'dark' },
      { name: 'system dark', rootClass: null, colorScheme: 'dark' },
      { name: 'system light', rootClass: null, colorScheme: 'light' },
    ]
    try {
      for (const state of themeStates) {
        await sidebar.emulateMedia({ colorScheme: state.colorScheme })
        const measurement = await measureIndicatorContrast(sidebar, '小程序', state.rootClass)
        expect(measurement.contrastToActive, `${state.name} ${JSON.stringify(measurement)}`).toBeGreaterThanOrEqual(3)
        expect(measurement.contrastToSidebar, `${state.name} ${JSON.stringify(measurement)}`).toBeGreaterThanOrEqual(3)
        const isDarkAppearance = state.rootClass === 'dark' || (state.rootClass === null && state.colorScheme === 'dark')
        if (isDarkAppearance) {
          expect(measurement.contrastToActive, `${state.name} ${JSON.stringify(measurement)}`).toBeLessThanOrEqual(4.5)
        }
      }
    } finally {
      await sidebar.emulateMedia({ colorScheme: null })
    }

    await selectProjectCategoryInUI(electronApp, 'minigame')
    await expect(minigame).toHaveAttribute('aria-pressed', 'true')
    await expect(minigame.locator('[data-active-indicator]')).toHaveCount(1)
    await expect(miniprogram.locator('[data-active-indicator]')).toHaveCount(0)
  })
})
