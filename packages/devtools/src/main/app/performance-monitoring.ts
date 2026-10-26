import type { App, BrowserWindow, PowerMonitor } from 'electron'
import { toDisposable, type DisposableRegistry } from 'electron-deck/main'
import {
  createPerformanceService,
  type PerformanceService,
} from '../services/performance/index.js'

const SAMPLE_INTERVAL_MS = 30_000

/** Installs local-only memory attribution and system idle sampling. */
export function createPerformanceMonitoring(
  app: Pick<App, 'getAppMetrics'>,
  powerMonitor: Pick<PowerMonitor, 'getSystemIdleTime' | 'on' | 'removeListener'>,
  projectListWindow: BrowserWindow,
  registry: DisposableRegistry,
): PerformanceService {
  const performance = createPerformanceService({ metrics: () => app.getAppMetrics() })
  registry.add(performance.registerOwner({
    webContentsId: projectListWindow.webContents.id,
    role: 'project-list',
    pid: () => projectListWindow.webContents.isDestroyed()
      ? undefined
      : projectListWindow.webContents.getOSProcessId(),
  }))

  const sample = (): void => {
    try {
      performance.sample({ idleSeconds: powerMonitor.getSystemIdleTime() })
    } catch (error) {
      console.warn('[performance] system idle sampling failed:', error)
    }
  }
  const onResume = (): void => {
    performance.noteWake()
    sample()
  }
  powerMonitor.on('resume', onResume)
  const timer = setInterval(sample, SAMPLE_INTERVAL_MS)
  sample()
  registry.add(toDisposable(() => {
    clearInterval(timer)
    powerMonitor.removeListener('resume', onResume)
  }))
  registry.add(performance)
  return performance
}
