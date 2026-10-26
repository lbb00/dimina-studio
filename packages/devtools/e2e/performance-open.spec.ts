import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  addProject,
  closeProject,
  DEMO_APP_DIR,
  findMainWindow,
  findWorkbenchWindow,
  pollUntil,
  refreshProjectList,
} from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface PerformanceTrace {
  events: Array<{ name: string; at: number }>
  completedAt?: number
}

interface PerformanceSample {
  totalWorkingSetSizeKb: number
  counters: Record<string, number>
  processes: Array<{ pid: number; workingSetSizeKb: number; owners: Array<{ role: string; sessionId?: string }> }>
}

interface CapturedPage {
  png: string
  colorRange: number
}

async function captureWorkbenchShell(electronApp: ElectronApplication): Promise<CapturedPage> {
  return electronApp.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes('workbench'))
    if (!window) throw new Error('workbench window was not created')
    const image = await window.webContents.capturePage()
    const bitmap = image.toBitmap()
    let minimum = 255
    let maximum = 0
    for (let index = 0; index < bitmap.length; index += 4) {
      minimum = Math.min(minimum, bitmap[index]!, bitmap[index + 1]!, bitmap[index + 2]!)
      maximum = Math.max(maximum, bitmap[index]!, bitmap[index + 1]!, bitmap[index + 2]!)
    }
    return { png: image.toPNG().toString('base64'), colorRange: maximum - minimum }
  })
}

async function captureActiveRender(electronApp: ElectronApplication): Promise<CapturedPage> {
  return electronApp.evaluate(async () => {
    const instance = (globalThis as unknown as { __e2ePerformanceInstance: PerformanceInstance })
      .__e2ePerformanceInstance
    const render = instance.projectWindows()[0]?.context.bridge?.getActiveRenderWc()
    if (!render) throw new Error('active render WebContents was not created')
    const image = await render.capturePage()
    const bitmap = image.toBitmap()
    let minimum = 255
    let maximum = 0
    for (let index = 0; index < bitmap.length; index += 4) {
      minimum = Math.min(minimum, bitmap[index]!, bitmap[index + 1]!, bitmap[index + 2]!)
      maximum = Math.max(maximum, bitmap[index]!, bitmap[index + 1]!, bitmap[index + 2]!)
    }
    return { png: image.toPNG().toString('base64'), colorRange: maximum - minimum }
  })
}

async function openNativeProject(
  electronApp: ElectronApplication,
): Promise<{ workbench: Page; contentCharacters: number; confirmedAt: number }> {
  const listWindow = await findMainWindow(electronApp)
  await addProject(listWindow, DEMO_APP_DIR)
  await refreshProjectList(listWindow)
  const projectPathLabel = listWindow.locator(`[title="${DEMO_APP_DIR}"]`).first()
  await projectPathLabel.waitFor()
  await projectPathLabel.locator('..').click()

  const workbench = await findWorkbenchWindow(electronApp, { projectDir: DEMO_APP_DIR, timeoutMs: 60_000 })
  await workbench.waitForLoadState('domcontentloaded')
  await workbench.waitForSelector('text=普通编译')
  const compileComplete = await pollUntil(
    () => workbench.evaluate(() => [...document.querySelectorAll('[class*="truncate"]')]
      .some((element) => (element.textContent || '').includes('完成'))),
    (complete) => complete,
    60_000,
    200,
  )
  expect(compileComplete, 'the workbench must report compilation complete').toBe(true)

  const visible = await pollUntil(
    () => electronApp.evaluate(async () => {
      const instance = (globalThis as unknown as { __e2ePerformanceInstance: PerformanceInstance })
        .__e2ePerformanceInstance
      const render = instance.projectWindows()[0]?.context.bridge?.getActiveRenderWc()
      if (!render) return undefined
      return {
        contentCharacters: await render.executeJavaScript('document.body.innerText.length'),
        confirmedAt: performance.now(),
      }
    }),
    (result): result is { contentCharacters: number; confirmedAt: number } => Boolean(result && result.contentCharacters > 0),
    60_000,
    200,
  )
  expect(visible, 'the active native render guest must contain page text').toBeDefined()
  return { workbench, ...visible! }
}

interface ActiveRenderWebContents {
  capturePage(): Promise<{ toBitmap(): Buffer; toPNG(): Buffer }>
  executeJavaScript(source: string): Promise<number>
}

interface PerformanceInstance {
  performance: {
    listTraces(): PerformanceTrace[]
    sample(options: { idleSeconds: number }): PerformanceSample | undefined
  }
  projectWindows(): Array<{
    context: { bridge?: { getActiveRenderWc(): ActiveRenderWebContents | null } }
  }>
}

test.describe('Performance project open', () => {
  test.setTimeout(120_000)
  let electronApp: ElectronApplication
  let childOutput = ''

  test.beforeAll(async () => {
    electronApp = await _electron.launch({
      args: [path.resolve(__dirname, 'performance-entry.js')],
      env: { ...process.env, DIMINA_NATIVE_HOST: '1', DIMINA_PERFORMANCE: '1', NODE_ENV: 'test' },
    })
    const child = electronApp.process()
    child.stdout?.on('data', (chunk: Buffer) => { childOutput += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => {
      childOutput += chunk.toString()
      console.error(`[performance-e2e child stderr] ${chunk}`)
    })
    child.on('exit', (code, signal) => {
      childOutput += `\n[child-exit] code=${code} signal=${signal}\n`
      console.error(`[performance-e2e child-exit] code=${code} signal=${signal}`)
    })
  })

  test.afterAll(async () => {
    await closeProject(electronApp).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  // eslint-disable-next-line no-empty-pattern -- this spec owns its dedicated Electron process.
  test('opens, closes, and reopens visible project content with attributed process samples', async ({}, testInfo) => {
    let stage = 'recording first main-process timestamp'
    try {
      const firstClickAt = await electronApp.evaluate(() => performance.now())
      stage = 'opening the first project through the project list'
      const firstOpen = await openNativeProject(electronApp)
      stage = 'capturing the first active render guest'
      const firstContentCapture = await captureActiveRender(electronApp)
      expect(firstContentCapture.png.length, 'active render capturePage must contain image data').toBeGreaterThan(100)
      expect(firstContentCapture.colorRange, 'active render capturePage must not be one flat background').toBeGreaterThan(10)
      const firstShellCapture = await captureWorkbenchShell(electronApp)
      await testInfo.attach('first-content-visible.png', {
        body: Buffer.from(firstContentCapture.png, 'base64'),
        contentType: 'image/png',
      })
      await testInfo.attach('first-workbench-shell.png', {
        body: Buffer.from(firstShellCapture.png, 'base64'),
        contentType: 'image/png',
      })

      await closeProject(electronApp, { projectDir: DEMO_APP_DIR })
      stage = 'recording second main-process timestamp'
      const secondClickAt = await electronApp.evaluate(() => performance.now())
      stage = 'opening the project again through the project list'
      const secondOpen = await openNativeProject(electronApp)
      stage = 'capturing the reopened active render guest'
      const secondContentCapture = await captureActiveRender(electronApp)
      expect(secondContentCapture.colorRange, 'reopened active render capturePage must not be one flat background').toBeGreaterThan(10)
      await testInfo.attach('second-content-visible.png', {
        body: Buffer.from(secondContentCapture.png, 'base64'),
        contentType: 'image/png',
      })

      const result = await pollUntil(
        () => electronApp.evaluate(() => {
          const instance = (globalThis as unknown as { __e2ePerformanceInstance: PerformanceInstance })
            .__e2ePerformanceInstance
          return {
            sample: instance.performance.sample({ idleSeconds: 1 }),
            traces: instance.performance.listTraces(),
          }
        }),
        ({ sample, traces }) => Boolean(
          (sample?.counters['bridge.appSessions'] ?? 0) >= 1
          && (sample?.counters['bridge.pageSessions'] ?? 0) >= 1
          && sample.processes.flatMap((process) => process.owners).some((owner) => owner.role === 'project-window' && owner.sessionId === DEMO_APP_DIR)
          && sample.processes.flatMap((process) => process.owners).some((owner) => owner.role === 'service-host' && owner.sessionId)
          && sample.processes.flatMap((process) => process.owners).some((owner) => owner.role === 'render-page' && owner.sessionId)
          && traces.length >= 2,
        ),
        20_000,
        200,
      )
      expect(result.sample, 'performance sample must include native runtime owners').toBeDefined()
      const sample = result.sample!
      expect(sample.totalWorkingSetSizeKb).toBe(
        sample.processes.reduce((total, process) => total + process.workingSetSizeKb, 0),
      )
      expect(new Set(sample.processes.map((process) => process.pid)).size).toBe(sample.processes.length)
      for (const trace of result.traces) {
        expect(trace.events.map((event) => event.name)).toEqual(expect.arrayContaining(['window-shown']))
        expect(trace.events.filter((event) => event.name === 'window-shown')).toHaveLength(1)
        expect(trace.completedAt).toBeDefined()
      }
      await testInfo.attach('first-content-visible.json', {
        body: JSON.stringify({
          firstContentCharacters: firstOpen.contentCharacters,
          secondContentCharacters: secondOpen.contentCharacters,
          firstGuestCaptureBytes: firstContentCapture.png.length,
          firstGuestColorRange: firstContentCapture.colorRange,
          firstShellCaptureBytes: firstShellCapture.png.length,
          secondGuestCaptureBytes: secondContentCapture.png.length,
          secondGuestColorRange: secondContentCapture.colorRange,
          firstClickToVisibleMs: firstOpen.confirmedAt - firstClickAt,
          secondClickToVisibleMs: secondOpen.confirmedAt - secondClickAt,
          sample,
          traces: result.traces,
        }, null, 2),
        contentType: 'application/json',
      })
      await testInfo.attach('electron-output.log', { body: childOutput, contentType: 'text/plain' })
    } catch (error) {
      await testInfo.attach('electron-output.log', {
        body: childOutput,
        contentType: 'text/plain',
      })
      throw new Error(`performance E2E failed while ${stage}: ${String(error)}`, { cause: error })
    }
  })
})
