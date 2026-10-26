import { describe, expect, it, vi } from 'vitest'
import { createPerformanceMonitoring } from './performance-monitoring.js'

describe('performance monitoring', () => {
  it('samples system idle time, records resume, and removes its timer and listener on disposal', () => {
    vi.useFakeTimers()
    const listeners = new Set<() => void>()
    const registry: Array<{ dispose: () => void }> = []
    const powerMonitor = {
      getSystemIdleTime: vi.fn(() => 3),
      on: vi.fn((_event: string, listener: () => void) => { listeners.add(listener) }),
      removeListener: vi.fn((_event: string, listener: () => void) => { listeners.delete(listener) }),
    }
    const monitoring = createPerformanceMonitoring(
      { getAppMetrics: () => [] } as never,
      powerMonitor as never,
      { webContents: { id: 7, isDestroyed: () => false, getOSProcessId: () => 8 } } as never,
      { add: (disposable: { dispose: () => void }) => registry.push(disposable) } as never,
    )

    expect(powerMonitor.getSystemIdleTime).toHaveBeenCalledTimes(1)
    expect(listeners).toHaveLength(1)
    vi.advanceTimersByTime(30_000)
    expect(powerMonitor.getSystemIdleTime).toHaveBeenCalledTimes(2)
    for (const listener of listeners) listener()
    expect(monitoring.listSamples().at(-1)?.activity).toBe('wake')

    for (const disposable of registry) disposable.dispose()
    expect(listeners).toHaveLength(0)
    vi.advanceTimersByTime(30_000)
    expect(powerMonitor.getSystemIdleTime).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })

  it('reports an unavailable idle source and keeps startup alive', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => createPerformanceMonitoring(
      { getAppMetrics: () => [] } as never,
      {
        getSystemIdleTime: () => { throw new Error('unavailable') },
        on: () => undefined,
        removeListener: () => undefined,
      } as never,
      { webContents: { id: 7, isDestroyed: () => false, getOSProcessId: () => 8 } } as never,
      { add: () => undefined } as never,
    )).not.toThrow()
    expect(warn).toHaveBeenCalledWith('[performance] system idle sampling failed:', expect.any(Error))
    warn.mockRestore()
  })
})
