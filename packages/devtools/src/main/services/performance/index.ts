import type { Disposable } from 'electron-deck/main'

export type PerformanceOwnerRole = string

export interface PerformanceOwner {
  webContentsId: number
  role: PerformanceOwnerRole
  sessionId?: string
  pid: () => number | undefined
}

export interface ProcessMemoryMetric {
  pid: number
  memory: { workingSetSize: number }
}

/** Electron reports `workingSetSize` in KiB. */
export interface MemoryProcessSample {
  pid: number
  workingSetSizeKb: number
  owners: Array<Pick<PerformanceOwner, 'webContentsId' | 'role' | 'sessionId'>>
}

export interface MemorySample {
  at: number
  idleSeconds?: number
  activity: 'idle' | 'active' | 'wake'
  trend: 'baseline' | 'sustained-growth' | 'step' | 'wake'
  totalWorkingSetSizeKb: number
  processes: MemoryProcessSample[]
  counters: Record<string, number>
}

export interface PerformanceTrace {
  id: number
  projectPath: string
  events: Array<{ name: string; at: number }>
  completedAt?: number
}

export interface PerformanceService {
  startProjectOpen(projectPath: string): number
  mark(traceId: number | undefined, name: string): void
  complete(traceId: number | undefined, name: string): void
  getTrace(traceId: number): PerformanceTrace | undefined
  listTraces(): PerformanceTrace[]
  registerOwner(owner: PerformanceOwner): Disposable
  registerOwnerProvider(provider: () => PerformanceOwner[]): Disposable
  registerCounterProvider(name: string, provider: () => number): Disposable
  noteActivity(): void
  noteWake(): void
  sample(options?: { idleSeconds?: number }): MemorySample | undefined
  listSamples(): MemorySample[]
  dispose(): void
}

export interface CreatePerformanceServiceOptions {
  now?: () => number
  metrics?: () => ProcessMemoryMetric[]
  maxTraces?: number
  maxSamples?: number
  /** KiB increase required in every continuous idle interval. */
  growthThreshold?: number
  /** A longer gap starts a fresh idle run instead of bridging sleep. */
  maxIdleGapMs?: number
}

function copyTrace(trace: PerformanceTrace): PerformanceTrace {
  return { ...trace, events: trace.events.map((event) => ({ ...event })) }
}

function copySample(sample: MemorySample): MemorySample {
  return {
    ...sample,
    counters: { ...sample.counters },
    processes: sample.processes.map((process) => ({
      ...process,
      owners: process.owners.map((owner) => ({ ...owner })),
    })),
  }
}

export function createPerformanceService(
  options: CreatePerformanceServiceOptions = {},
): PerformanceService {
  const now = options.now ?? (() => performance.now())
  const maxTraces = options.maxTraces ?? 32
  const maxSamples = options.maxSamples ?? 120
  const growthThreshold = options.growthThreshold ?? 1
  const maxIdleGapMs = options.maxIdleGapMs ?? 120_000
  if (!Number.isInteger(maxTraces) || maxTraces < 1 || !Number.isInteger(maxSamples) || maxSamples < 1) {
    throw new Error('performance sample limits must be positive integers')
  }
  if (!Number.isFinite(maxIdleGapMs) || maxIdleGapMs <= 0) {
    throw new Error('maxIdleGapMs must be a positive number')
  }

  const owners = new Map<number, PerformanceOwner>()
  const ownerProviders = new Set<() => PerformanceOwner[]>()
  const counters = new Map<string, () => number>()
  const traces: PerformanceTrace[] = []
  const samples: MemorySample[] = []
  let nextTraceId = 1
  let nextActivity: MemorySample['activity'] = 'idle'
  let idleGrowthSegments = 0
  let disposed = false

  const trim = <T>(items: T[], limit: number): void => {
    if (items.length > limit) items.splice(0, items.length - limit)
  }
  const live = (): boolean => !disposed
  const resetIdleRun = (): void => { idleGrowthSegments = 0 }

  return {
    startProjectOpen(projectPath) {
      if (!live()) return 0
      const trace: PerformanceTrace = {
        id: nextTraceId++,
        projectPath,
        events: [{ name: 'open-requested', at: now() }],
      }
      traces.push(trace)
      trim(traces, maxTraces)
      return trace.id
    },
    mark(traceId, name) {
      const trace = traceId === undefined ? undefined : traces.find((item) => item.id === traceId)
      if (live() && trace && trace.completedAt === undefined) trace.events.push({ name, at: now() })
    },
    complete(traceId, name) {
      const trace = traceId === undefined ? undefined : traces.find((item) => item.id === traceId)
      if (!live() || !trace || trace.completedAt !== undefined) return
      const at = now()
      trace.events.push({ name, at })
      trace.completedAt = at
    },
    getTrace: (id) => {
      const trace = traces.find((item) => item.id === id)
      return trace && copyTrace(trace)
    },
    listTraces: () => traces.map(copyTrace),
    registerOwner(owner) {
      if (!live()) return { dispose() {} }
      owners.set(owner.webContentsId, owner)
      return {
        dispose() {
          if (owners.get(owner.webContentsId) === owner) owners.delete(owner.webContentsId)
        },
      }
    },
    registerOwnerProvider(provider) {
      if (!live()) return { dispose() {} }
      ownerProviders.add(provider)
      return { dispose() { ownerProviders.delete(provider) } }
    },
    registerCounterProvider(name, provider) {
      if (!live()) return { dispose() {} }
      counters.set(name, provider)
      return {
        dispose() {
          if (counters.get(name) === provider) counters.delete(name)
        },
      }
    },
    noteActivity() {
      if (live()) nextActivity = 'active'
    },
    noteWake() {
      if (live()) nextActivity = 'wake'
    },
    sample(sampleOptions = {}) {
      if (!live()) return undefined

      const ownersByPid = new Map<number, Map<number, Pick<PerformanceOwner, 'webContentsId' | 'role' | 'sessionId'>>>()
      const currentOwners = [...owners.values()]
      for (const provider of ownerProviders) {
        try {
          currentOwners.push(...provider())
        } catch {
          // A WebContents may be destroyed while its owning context tears down.
        }
      }
      for (const owner of currentOwners) {
        try {
          const pid = owner.pid()
          if (pid === undefined) continue
          const perProcess = ownersByPid.get(pid) ?? new Map()
          perProcess.set(owner.webContentsId, {
            webContentsId: owner.webContentsId,
            role: owner.role,
            sessionId: owner.sessionId,
          })
          ownersByPid.set(pid, perProcess)
        } catch {
          // A WebContents may disappear between the provider snapshot and pid read.
        }
      }

      const metricsByPid = new Map<number, ProcessMemoryMetric>()
      for (const metric of options.metrics?.() ?? []) metricsByPid.set(metric.pid, metric)
      const processes = [...metricsByPid.values()].map((metric) => ({
        pid: metric.pid,
        workingSetSizeKb: metric.memory.workingSetSize,
        owners: [...(ownersByPid.get(metric.pid)?.values() ?? [{ webContentsId: -1, role: 'unknown' }])],
      }))
      const totalWorkingSetSizeKb = processes.reduce((sum, item) => sum + item.workingSetSizeKb, 0)
      const at = now()
      const activity = nextActivity
      const previous = samples.at(-1)
      const idleSeconds = sampleOptions.idleSeconds
      let trend: MemorySample['trend'] = 'baseline'

      if (activity === 'wake') {
        resetIdleRun()
        trend = 'wake'
      } else if (activity === 'active') {
        resetIdleRun()
        trend = 'step'
      } else if (
        previous
        && previous.activity === 'idle'
        && previous.idleSeconds !== undefined
        && idleSeconds !== undefined
      ) {
        const elapsedMs = at - previous.at
        const expectedIdleAdvanceSeconds = elapsedMs / 1_000
        const actualIdleAdvanceSeconds = idleSeconds - previous.idleSeconds
        const isContinuousIdle = elapsedMs > 0
          && elapsedMs <= maxIdleGapMs
          && actualIdleAdvanceSeconds > 0
          && actualIdleAdvanceSeconds + 1 >= expectedIdleAdvanceSeconds
        const grew = totalWorkingSetSizeKb - previous.totalWorkingSetSizeKb >= growthThreshold
        if (isContinuousIdle && grew) {
          idleGrowthSegments += 1
          trend = idleGrowthSegments >= 3 ? 'sustained-growth' : 'step'
        } else {
          resetIdleRun()
        }
      } else if (activity === 'idle' && idleSeconds !== undefined && idleSeconds > 0) {
        idleGrowthSegments = 1
      } else {
        resetIdleRun()
      }

      const sampleCounters: Record<string, number> = {}
      for (const [name, provider] of counters) {
        try {
          const value = provider()
          if (Number.isFinite(value)) sampleCounters[name] = value
        } catch {
          // The counter's owner may be destroyed while sampling.
        }
      }
      const sample: MemorySample = {
        at,
        idleSeconds,
        activity,
        trend,
        totalWorkingSetSizeKb,
        processes,
        counters: sampleCounters,
      }
      samples.push(sample)
      trim(samples, maxSamples)
      nextActivity = 'idle'
      return copySample(sample)
    },
    listSamples: () => samples.map(copySample),
    dispose() {
      if (disposed) return
      disposed = true
      owners.clear()
      ownerProviders.clear()
      counters.clear()
      traces.length = 0
      samples.length = 0
      resetIdleRun()
    },
  }
}
