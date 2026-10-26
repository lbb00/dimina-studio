import { test, expect } from './fixtures'
import {
  DEMO_APP_DIR,
  addProject,
  closeProject,
  findWorkbenchWindow,
  listWorkbenchWindows,
  refreshProjectList,
  ipcInvoke,
} from './helpers'
import { ProjectsChannel } from '../src/shared/ipc-channels'

/**
 * Project cards use the same 176×180 cover ratio as WeChat Developer Tools.
 * The grid stays elastic, so this is measured in a real Electron window.
 */

/** Read every card's laid-out size, keyed by whether it is the create card. */
async function measureCards(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const probe = document.createElement('div')
    probe.className = 'rounded-xl border bg-card text-card-foreground shadow'
    probe.style.cssText = 'position:absolute;visibility:hidden'
    document.body.appendChild(probe)
    const expectedBackground = getComputedStyle(probe).backgroundColor
    const expectedForeground = getComputedStyle(probe).color
    probe.remove()
    return [...document.querySelectorAll('[data-project-card]')].map((el) => {
      const r = el.getBoundingClientRect()
      const media = el.querySelector('[data-project-card-media]')?.getBoundingClientRect()
      const style = getComputedStyle(el)
      return {
        isCreateCard: el.tagName === 'BUTTON',
        width: r.width,
        height: r.height,
        mediaWidth: media?.width ?? 0,
        mediaHeight: media?.height ?? 0,
        backgroundColor: style.backgroundColor,
        foregroundColor: style.color,
        borderColor: style.borderColor,
        expectedBackground,
        expectedForeground,
      }
    })
  })
}

async function setWindowWidth(
  electronApp: import('@playwright/test').ElectronApplication,
  width: number,
): Promise<void> {
  await electronApp.evaluate(async ({ BrowserWindow }, w) => {
    const win = BrowserWindow.getAllWindows()
      .find((b) => !b.isDestroyed() && b.webContents.getURL().includes('entries/main/'))
    if (!win) throw new Error('[e2e] no live main window to resize')
    const [, h] = win.getSize()
    win.setSize(w, h)
  }, width)
}

test.describe('project card proportions', () => {
  let originalWidth = 0

  test.beforeEach(async ({ electronApp, mainWindow }) => {
    originalWidth = await electronApp.evaluate(async ({ BrowserWindow }) => {
      // The main window by its own URL — devtools also owns secondary windows,
      // and creation order does not identify this one (see `findMainWindow`).
      const win = BrowserWindow.getAllWindows()
        .find((b) => !b.isDestroyed() && b.webContents.getURL().includes('entries/main/'))
      return win ? win.getSize()[0] : 0
    })
    await addProject(mainWindow, DEMO_APP_DIR)
    await refreshProjectList(mainWindow)
    await mainWindow.waitForSelector('[data-project-card]')
  })

  test.afterEach(async ({ electronApp, mainWindow }) => {
    if (originalWidth > 0) await setWindowWidth(electronApp, originalWidth)
    // The Electron app is worker-scoped and shared with every later spec —
    // a project left in the list changes what those specs' own `addProject`
    // calls do (it skips a project already listed, so their setup silently
    // stops running).
    await ipcInvoke(mainWindow, ProjectsChannel.Remove, DEMO_APP_DIR).catch(() => {})
  })

  test('real cards use semantic surfaces and WeChat-compatible cover previews', async ({ mainWindow }) => {
    await expect
      .poll(async () => Math.max(...(await measureCards(mainWindow)).map((card) => card.mediaWidth)))
      .toBeGreaterThan(0)
    const cards = (await measureCards(mainWindow)).filter((card) => !card.isCreateCard)
    expect(cards.length).toBeGreaterThan(0)
    for (const card of cards) {
      expect(card.mediaHeight / card.mediaWidth).toBeCloseTo(45 / 44, 2)
      expect(card.backgroundColor).toBe(card.expectedBackground)
      expect(card.foregroundColor).toBe(card.expectedForeground)
      expect(card.borderColor, 'card must keep the semantic border alpha').toMatch(/\/ 0\.1/)
    }
  })

  test('the create card matches a real project card at the same column width', async ({ electronApp, mainWindow }) => {
    await setWindowWidth(electronApp, 1200)
    await expect
      .poll(async () => (await measureCards(mainWindow)).length)
      .toBeGreaterThan(1)

    const cards = await measureCards(mainWindow)
    const createCard = cards.find((c) => c.isCreateCard)
    const projectCard = cards.find((c) => !c.isCreateCard)
    expect(createCard, 'create card missing from the grid').toBeTruthy()
    expect(projectCard, 'no project card in the grid').toBeTruthy()
    expect(createCard!.mediaWidth).toBe(0)
    expect(createCard!.mediaHeight).toBe(0)
    // Same row, so equal width is the grid's doing; equal HEIGHT is the part
    // the create card has to achieve on its own (it is the only item in an
    // empty list, with no sibling to be stretched against).
    expect(Math.abs(createCard!.height - projectCard!.height)).toBeLessThan(1)
  })

  test('the keyboard open control opens one project window', async ({ electronApp, mainWindow }) => {
    const open = mainWindow.locator('[data-project-card-open]').first()
    await open.focus()
    await open.press('Enter')

    try {
      await findWorkbenchWindow(electronApp, { projectDir: DEMO_APP_DIR })
      const matching = listWorkbenchWindows(electronApp).filter((win) =>
        new URL(win.url()).searchParams.get('path') === DEMO_APP_DIR,
      )
      expect(matching).toHaveLength(1)
    } finally {
      await closeProject(electronApp, { projectDir: DEMO_APP_DIR })
    }
  })
})
