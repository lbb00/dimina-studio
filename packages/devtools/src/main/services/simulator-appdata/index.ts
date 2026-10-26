/**
 * Native-host AppData panel service.
 *
 * Taps the service→render setData stream (bridge-router SERVICE_PUBLISH) — under
 * native-host the service logic runs in the hidden service-host window, not a
 * Worker in the simulator guest, so the default Worker-hook source goes blind.
 * Decodes + accumulates per app via the SHARED `AppDataAccumulator`, mirroring
 * the Storage/WXML main→renderer contract:
 *   - PULL: answers `SimulatorAppDataChannel.GetSnapshot` with the ACTIVE app's
 *     cumulative `accumulator.snapshot()` (empty snapshot when it has no data).
 *   - PUSH: on each accepted message / bridge eviction for the ACTIVE app,
 *     schedules a throttled push of the updated snapshot via
 *     `SimulatorAppDataChannel.Event` (see PUSH_COALESCE_MS below) — a
 *     `setData` storm is rate-limited to at most one send per
 *     PUSH_COALESCE_MS window instead of one `snapshot()` rebuild + IPC
 *     send per message.
 */
import type { WebContents } from 'electron'
import type { MessageEnvelope } from '../../../shared/bridge-channels.js'
import { ServiceHostChannel, SimulatorAppDataChannel } from '../../../shared/ipc-channels.js'
import {
  AppDataAccumulator,
  decodeWorkerMessage,
  decodedToInput,
  type AppDataSnapshot,
} from '@dimina-studio/inspect'
import { DisposableRegistry, type Disposable } from 'electron-deck/main'
import { IpcRegistry, type SenderPolicy } from '../../utils/ipc-registry.js'

export interface AppDataTap {
  /** Feed one service→render message for an app; decodes + accumulates + pushes if active. */
  onServiceToRender(appId: string, msg: MessageEnvelope): void
  /** Evict a page bridge (page teardown) from an app's accumulator; pushes if active. */
  evictBridge(appId: string, bridgeId: string): void
  /** The ACTIVE app's current reactive page state for a bridge (`{}` when none). */
  getPageData(bridgeId: string): Record<string, unknown>
  /** Snapshot all accumulated appdata for an app. Optional for compatibility with tests/mocks. */
  snapshot?: (appId: string) => unknown
}

export interface SimulatorAppDataService extends AppDataTap, Disposable {}

export interface SimulatorAppDataOptions {
  getActiveAppId: () => string | null
  senderPolicy?: SenderPolicy
  /** Resolves the service-host WebContents owning a page bridge — the SetData
   * write-back target. Absent (host without a service bridge) → edits are
   * rejected with `false`. */
  bridge?: { getServiceWcForBridge: (bridgeId: string) => WebContents | null }
}

const EMPTY_SNAPSHOT: AppDataSnapshot = { bridges: [], entries: {} }

/**
 * Bounded-latency throttle window for service→render `setData` pushes — same
 * value and shape as the preload WXML observer's debounce
 * (`WXML_DEBOUNCE_MS`, preload/instrumentation/wxml.ts). Unlike a pure
 * debounce, the timer starts on the FIRST message after a flush and later
 * messages in the same window never reset it — only update which value
 * flush() will read. A `setData` storm (list/animation updates firing tens
 * of times a second) still collapses into far fewer sends than one per
 * message, but a SUSTAINED stream (e.g. a countdown ticking every 100ms)
 * keeps getting flushed at least once every PUSH_COALESCE_MS instead of
 * being starved forever by continuously-deferred resets — it never
 * withholds a push indefinitely waiting for a quiet period.
 */
export const PUSH_COALESCE_MS = 300
const SET_DATA_ACK_TIMEOUT_MS = 5_000

export function setupSimulatorAppData(
  host: WebContents,
  options: SimulatorAppDataOptions,
): SimulatorAppDataService {
  const { getActiveAppId } = options
  // One accumulator per app — native-host can host multiple sessions; the panel
  // only ever shows the active one (resolved via getActiveAppId).
  const accumulators = new Map<string, AppDataAccumulator>()

  function accumulatorFor(appId: string): AppDataAccumulator {
    let acc = accumulators.get(appId)
    if (!acc) {
      acc = new AppDataAccumulator()
      accumulators.set(appId, acc)
    }
    return acc
  }

  // Coalesced push state — see PUSH_COALESCE_MS. `pendingPushAppId` is
  // re-checked against getActiveAppId() at fire time (not just at schedule
  // time) since the active app can change while a push is in flight.
  let pushTimer: ReturnType<typeof setTimeout> | undefined
  let pendingPushAppId: string | null = null

  function flushPush(): void {
    pushTimer = undefined
    const appId = pendingPushAppId
    pendingPushAppId = null
    if (appId === null) return
    if (appId !== getActiveAppId()) return
    if (host.isDestroyed()) return
    host.send(SimulatorAppDataChannel.Event, accumulatorFor(appId).snapshot())
  }

  /**
   * Schedule the active app's snapshot push to the renderer (no-op for
   * non-active/destroyed). Throttled, not debounced: a call only starts the
   * timer when none is already pending; calls that land while one is
   * pending just update `pendingPushAppId` (already the latest appId — the
   * accumulator itself, read at flush time, carries the latest data) and
   * never push the deadline out. That bounds worst-case latency at
   * PUSH_COALESCE_MS even under a sustained stream of calls, instead of the
   * timer being reset forever and never firing.
   */
  function pushIfActive(appId: string): void {
    if (appId !== getActiveAppId()) return
    if (host.isDestroyed()) return
    pendingPushAppId = appId
    if (pushTimer !== undefined) return
    pushTimer = setTimeout(flushPush, PUSH_COALESCE_MS)
  }

  function onServiceToRender(appId: string, msg: MessageEnvelope): void {
    const entries = decodeWorkerMessage(msg)
    if (!entries) return
    const acc = accumulatorFor(appId)
    let mutated = false
    for (const entry of entries) {
      if (acc.apply(decodedToInput(entry))) mutated = true
    }
    if (mutated) pushIfActive(appId)
  }

  function evictBridge(appId: string, bridgeId: string): void {
    settleForBridge(bridgeId)
    accumulatorFor(appId).clearBridge(bridgeId)
    pushIfActive(appId)
  }

  function getPageData(bridgeId: string): Record<string, unknown> {
    const activeAppId = getActiveAppId()
    if (!activeAppId) return {}
    return accumulators.get(activeAppId)?.pageData(bridgeId) ?? {}
  }

  const ipc = new IpcRegistry(options.senderPolicy)
  let nextSetDataId = 0
  const pendingSetData = new Map<number, {
    bridgeId: string
    wc: WebContents
    resolve: (applied: boolean) => void
    timer: ReturnType<typeof setTimeout>
    onDestroyed: () => void
  }>()

  function settleSetData(id: number, applied: boolean): void {
    const pending = pendingSetData.get(id)
    if (!pending) return
    pendingSetData.delete(id)
    clearTimeout(pending.timer)
    pending.wc.removeListener('destroyed', pending.onDestroyed)
    pending.resolve(applied)
  }

  function settleForBridge(bridgeId: string): void {
    for (const [id, pending] of pendingSetData) {
      if (pending.bridgeId === bridgeId) settleSetData(id, false)
    }
  }
  ipc.handle(SimulatorAppDataChannel.GetSnapshot, () => {
    const appId = getActiveAppId()
    if (!appId) return EMPTY_SNAPSHOT
    return accumulators.get(appId)?.snapshot() ?? EMPTY_SNAPSHOT
  })

  /** A plain, non-empty `{key: value}` patch — the only shape page.setData accepts. */
  function isValidSetDataPatch(data: unknown): data is Record<string, unknown> {
    return !!data && typeof data === 'object' && !Array.isArray(data)
      && Object.keys(data as Record<string, unknown>).length > 0
  }

  ipc.handle(SimulatorAppDataChannel.SetData, (_event, payload: unknown) => {
    const p = payload as { bridgeId?: unknown; data?: unknown } | null
    if (!p || typeof p !== 'object') return false
    if (typeof p.bridgeId !== 'string' || p.bridgeId.length === 0) return false
    if (!isValidSetDataPatch(p.data)) return false
    const bridgeId = p.bridgeId
    const data = p.data
    const wc = options.bridge?.getServiceWcForBridge(bridgeId)
    if (!wc || wc.isDestroyed()) return false
    const id = ++nextSetDataId
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => settleSetData(id, false), SET_DATA_ACK_TIMEOUT_MS)
      const onDestroyed = () => settleSetData(id, false)
      pendingSetData.set(id, { bridgeId, wc, resolve, timer, onDestroyed })
      wc.once('destroyed', onDestroyed)
      try {
        wc.send(ServiceHostChannel.AppDataSetData, { id, bridgeId, data })
      } catch {
        settleSetData(id, false)
      }
    })
  })
  // Service hosts are outside the renderer whitelist. Only a host owning an
  // outstanding write may acknowledge it; the registry also checks its frame.
  const acknowledgements = new IpcRegistry(sender =>
    !sender.isDestroyed() && [...pendingSetData.values()].some(pending => pending.wc === sender),
  )
  acknowledgements.on(ServiceHostChannel.AppDataSetDataResult, (event, payload: unknown) => {
    const p = payload as { id?: unknown; bridgeId?: unknown; applied?: unknown } | null
    if (!p || typeof p.id !== 'number' || typeof p.bridgeId !== 'string' || typeof p.applied !== 'boolean') return
    const pending = pendingSetData.get(p.id)
    if (!pending || pending.wc !== event.sender || pending.bridgeId !== p.bridgeId) return
    settleSetData(p.id, p.applied)
  })

  // disposeAll runs LIFO; add this LAST so it is torn down FIRST — the only
  // entry guaranteed to complete before the first `await` yields, which
  // callers that `dispose()` without awaiting rely on (see IpcRegistry's own
  // comment). Cancelling the pending coalesced-push timer alongside the IPC
  // removeHandler calls in this same entry ensures a stray send can never
  // fire after dispose() returns, even for a fire-and-forget caller.
  const registry = new DisposableRegistry()
  registry.add(() => accumulators.clear())
  registry.add(() => {
    for (const id of pendingSetData.keys()) settleSetData(id, false)
    clearTimeout(pushTimer)
    pushTimer = undefined
    pendingPushAppId = null
    acknowledgements.dispose()
    ipc.dispose()
  })

  return {
    onServiceToRender,
    evictBridge,
    getPageData,
    snapshot: (appId) => accumulatorFor(appId).snapshot(),
    dispose: () => registry.dispose(),
  }
}
