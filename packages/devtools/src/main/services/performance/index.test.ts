import { describe, expect, it } from 'vitest'
import { createPerformanceService } from './index.js'

describe('performance service', () => {
  it('counts a shared pid once while preserving every registered owner', () => {
    const service = createPerformanceService({
      now: () => 100,
      metrics: () => [
        { pid: 7, memory: { workingSetSize: 42 } },
        { pid: 7, memory: { workingSetSize: 42 } },
        { pid: 8, memory: { workingSetSize: 9 } },
      ],
    })
    service.registerOwner({ webContentsId: 1, pid: () => 7, role: 'editor', sessionId: 'a' })
    service.registerOwner({ webContentsId: 2, pid: () => 7, role: 'simulator', sessionId: 'a' })

    const sample = service.sample({ idleSeconds: 5 })!
    expect(sample.totalWorkingSetSizeKb).toBe(51)
    expect(sample.processes).toContainEqual(expect.objectContaining({
      pid: 7,
      workingSetSizeKb: 42,
      owners: [
        { webContentsId: 1, role: 'editor', sessionId: 'a' },
        { webContentsId: 2, role: 'simulator', sessionId: 'a' },
      ],
    }))
  })

  it('keeps bounded traces and records an existing-window focus as a complete open', () => {
    let time = 0
    const service = createPerformanceService({ now: () => ++time, maxTraces: 1 })
    const trace = service.startProjectOpen('/project/a')
    service.mark(trace, 'window-created')
    service.complete(trace, 'existing-window-focused')
    expect(service.getTrace(trace)?.completedAt).toBe(3)
    service.startProjectOpen('/project/b')
    expect(service.listTraces()).toHaveLength(1)
  })

  it('keeps wake and active samples separate from following idle samples', () => {
    const service = createPerformanceService({ metrics: () => [] })
    service.noteWake()
    expect(service.sample({ idleSeconds: 5 })!.activity).toBe('wake')
    service.noteActivity()
    expect(service.sample({ idleSeconds: 5 })!.activity).toBe('active')
    expect(service.sample({ idleSeconds: 5 })!.activity).toBe('idle')
  })

  it('requires three continuous, monotonic idle samples before reporting sustained growth', () => {
    let time = 0
    let size = 10
    const service = createPerformanceService({
      now: () => time,
      metrics: () => [{ pid: 1, memory: { workingSetSize: size } }],
      growthThreshold: 2,
    })
    expect(service.sample({ idleSeconds: 3 })!.trend).toBe('baseline')
    time += 1_000
    size = 13
    expect(service.sample({ idleSeconds: 4 })!.trend).toBe('step')
    time += 1_000
    size = 16
    expect(service.sample({ idleSeconds: 5 })!.trend).toBe('sustained-growth')
  })

  it('resets an idle run when system idle time reveals activity, resume, or a long gap', () => {
    let time = 0
    let size = 10
    const service = createPerformanceService({
      now: () => time,
      metrics: () => [{ pid: 1, memory: { workingSetSize: size } }],
      growthThreshold: 2,
      maxIdleGapMs: 5_000,
    })
    service.sample({ idleSeconds: 3 })
    time += 1_000
    size = 13
    expect(service.sample({ idleSeconds: 4 })!.trend).toBe('step')
    time += 1_000
    size = 16
    expect(service.sample({ idleSeconds: 1 })!.trend).toBe('baseline')
    time += 1_000
    size = 19
    expect(service.sample({ idleSeconds: 2 })!.trend).toBe('step')
    service.noteWake()
    time += 1_000
    size = 22
    expect(service.sample({ idleSeconds: 3 })!.trend).toBe('wake')
    time += 6_000
    size = 25
    expect(service.sample({ idleSeconds: 9 })!.trend).toBe('baseline')
  })

  it('does not let an old disposer delete a replacement owner and stays terminal after dispose', () => {
    const service = createPerformanceService({ metrics: () => [{ pid: 1, memory: { workingSetSize: 1 } }] })
    const oldOwner = service.registerOwner({ webContentsId: 1, role: 'old', pid: () => 1 })
    service.registerOwner({ webContentsId: 1, role: 'new', pid: () => 1 })
    oldOwner.dispose()
    expect(service.sample({ idleSeconds: 1 })!.processes[0]!.owners[0]!.role).toBe('new')
    service.dispose()
    expect(service.startProjectOpen('/after-dispose')).toBe(0)
    expect(service.sample()).toBeUndefined()
  })
})
