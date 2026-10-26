import { test, expect, _electron, type ElectronApplication } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import { evalInWebContentsByUrl, findMainWindow, pollUntil } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

for (const entry of ['update-local-flow-entry.js', 'update-differential-entry.js']) {
test.describe(`Update dialog local flow: ${entry}`, () => {
  test.setTimeout(60_000)
  let electronApp: ElectronApplication
  let applicationLog = ''

  test.beforeAll(async () => {
    electronApp = await _electron.launch({
      args: [path.resolve(__dirname, entry)],
      env: { ...process.env, NODE_ENV: 'test' },
    })
    const record = (chunk: Buffer): void => { applicationLog += chunk.toString() }
    electronApp.process().stdout?.on('data', record)
    electronApp.process().stderr?.on('data', record)
    electronApp.process().on('exit', (code, signal) => { applicationLog += `\nEXIT=${code} SIGNAL=${signal}\n` })
  })

  test.afterEach(async () => {
    const testInfo = test.info()
    await testInfo.attach('electron.log', { body: applicationLog, contentType: 'text/plain' })
  })

  test.afterAll(async () => {
    await electronApp?.close().catch(() => {})
  })

  test('continues a hidden download, restores its progress from the menu, and retries a failure', async () => {
    const testInfo = test.info()
    const window = await findMainWindow(electronApp)
    await window.waitForLoadState('domcontentloaded')
    await expect(window.locator('body')).toContainText('新建小程序')
    await electronApp.evaluate(() => (globalThis as { __e2eUpdateControl: { allowUpdateCheck(): void } }).__e2eUpdateControl.allowUpdateCheck())
    const attachDialog = async (name: string): Promise<void> => {
      const png = await electronApp.evaluate(async ({ webContents }) => {
        const dialog = webContents.getAllWebContents().find((contents) => contents.getURL().includes('entries/update-dialog'))
        if (!dialog) throw new Error('Update dialog is missing')
        const image = await dialog.capturePage()
        if (image.isEmpty()) throw new Error('Update dialog has no captured frame')
        return image.toPNG().toString('base64')
      })
      await testInfo.attach(name, { body: Buffer.from(png, 'base64'), contentType: 'image/png' })
    }
    await pollUntil(
      () => evalInWebContentsByUrl<string>(electronApp, 'entries/update-dialog', 'document.body.innerText'),
      (text) => text.includes('Update Available'),
      20_000,
      200,
    )
    await evalInWebContentsByUrl(electronApp, 'entries/update-dialog', `
      Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('Download'))?.click()
    `)
    await expect.poll(() => evalInWebContentsByUrl<string>(electronApp, 'entries/update-dialog', 'document.body.innerText'))
      .toContain('Downloading... 37%')
    await attachDialog('download-progress.png')

    await evalInWebContentsByUrl(electronApp, 'entries/update-dialog', `
      document.querySelector('[role="dialog"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    `)
    await expect.poll(() => evalInWebContentsByUrl<string>(electronApp, 'entries/update-dialog', 'document.body.innerText'))
      .not.toContain('Downloading... 37%')
    await electronApp.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.items[0]?.submenu?.items.find((item) => item.label === '检查更新')?.click()
    })
    await expect.poll(() => evalInWebContentsByUrl<string>(electronApp, 'entries/update-dialog', 'document.body.innerText'))
      .toContain('Downloading... 37%')

    await electronApp.evaluate(() => (globalThis as { __e2eUpdateControl: { failFirstDownload(): void } }).__e2eUpdateControl.failFirstDownload())
    await expect.poll(() => evalInWebContentsByUrl<string>(electronApp, 'entries/update-dialog', 'document.body.innerText'))
      .toContain('Download failed: Error: temporary download failure')
    await evalInWebContentsByUrl(electronApp, 'entries/update-dialog', `
      Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('Retry'))?.click()
    `)
    await expect.poll(() => evalInWebContentsByUrl<string>(electronApp, 'entries/update-dialog', 'document.body.innerText'))
      .toContain('Ready to Install')
    await attachDialog('download-retry-complete.png')
    if (entry === 'update-differential-entry.js') {
      await evalInWebContentsByUrl(electronApp, 'entries/update-dialog', `
        Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('Install & Restart'))?.click()
      `)
      await expect.poll(() => electronApp.evaluate(() =>
        (globalThis as { __e2eUpdateControl: { snapshot(): { installs: number } } }).__e2eUpdateControl.snapshot().installs,
      )).toBe(1)
      const snapshot = await electronApp.evaluate(() =>
        (globalThis as { __e2eUpdateControl: { snapshot(): Record<string, unknown> } }).__e2eUpdateControl.snapshot(),
      )
      expect(snapshot).toMatchObject({
        downloads: 2, installs: 1, autoDownload: false,
        autoInstallOnAppQuit: false, disableDifferentialDownload: false,
      })
    }
  })
})
}
