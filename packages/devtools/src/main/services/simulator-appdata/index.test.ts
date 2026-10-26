/**
 * Behavior tests for setupSimulatorAppData.
 *
 * Native-host AppData panel service. Mirrors simulator-storage / simulator-wxml's
 * main→renderer contract, but the source of truth is the SHARED
 * `AppDataAccumulator` (one per appId), fed from the service→render message
 * stream:
 *   - PULL: answers `SimulatorAppDataChannel.GetSnapshot` with the ACTIVE app's
 *     `accumulator.snapshot()` (empty snapshot when the active app has no data).
 *   - PUSH: on each accepted message / bridge eviction for the ACTIVE app,
 *     pushes `accumulator.snapshot()` via `SimulatorAppDataChannel.Event`.
 *
 * We mock electron's ipcMain (capturing the GetSnapshot handler so we can invoke
 * it directly) and pass a fake host with a `send` spy. The shared accumulator is
 * NOT mocked — we let it decode/merge for real and assert on snapshot contents.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

// ── Electron stub (hoisted so vi.mock factory can reference it) ─────────
const stub = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown
  const ipcHandlers = new Map<string, Handler>()
  const ipcListeners = new Map<string, Handler>()

  const ipcMainStub = {
    handle: vi.fn((channel: string, fn: Handler) => {
      ipcHandlers.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel)
    }),
    on: vi.fn((channel: string, fn: Handler) => { ipcListeners.set(channel, fn) }),
    removeListener: vi.fn((channel: string) => { ipcListeners.delete(channel) }),
  }

  return { ipcHandlers, ipcListeners, ipcMainStub }
})

const { ipcHandlers, ipcListeners, ipcMainStub } = stub

vi.mock('electron', () => ({
  ipcMain: stub.ipcMainStub,
  app: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { getAllWebContents: vi.fn(() => []) },
  BrowserWindow: class {},
}))

// Import AFTER the mock so the module picks up the stubs.
import type { MessageEnvelope } from '../../../shared/bridge-channels.js'
import type { AppDataSnapshot } from '@dimina-studio/inspect'
import { ServiceHostChannel, SimulatorAppDataChannel } from '../../../shared/ipc-channels.js'
import { PUSH_COALESCE_MS, setupSimulatorAppData } from './index.js'

const require = createRequire(import.meta.url)
const { applyAppDataSetData } = require('../../../service-host/appdata-set-data.cjs') as {
  applyAppDataSetData: (getPages: unknown, bridgeId: string, data: Record<string, unknown>) => boolean
}

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

function getHandler(channel: string): IpcHandler {
  const fn = ipcHandlers.get(channel)
  if (!fn) throw new Error(`no ipc handler registered for ${channel}`)
  return fn as IpcHandler
}

function emit(channel: string, sender: Electron.WebContents, payload: unknown): void {
  const listener = ipcListeners.get(channel)
  if (!listener) throw new Error(`no ipc listener registered for ${channel}`)
  listener({ sender }, payload)
}

function makeHost() {
  const listeners = new Map<string, () => void>()
  return {
    isDestroyed: vi.fn(() => false),
    getURL: vi.fn(() => "file:///service-host/service.html"),
    send: vi.fn(),
    once: vi.fn((event: string, listener: () => void) => { listeners.set(event, listener) }),
    removeListener: vi.fn((event: string) => { listeners.delete(event) }),
    emit: (event: string) => listeners.get(event)?.(),
  } as unknown as Electron.WebContents
}

// ── Real service→render message fixtures (shapes the accumulator decodes) ──
const APP = 'wx123'
const OTHER = 'wxOTHER'

/** Page instance init: full initial state for a page bridge. */
function pageInit(bridgeId: string, path: string, data: Record<string, unknown>): MessageEnvelope {
  return { type: 'page_1', target: 'render', body: { bridgeId, path, data } }
}

/** Update batch: a partial setData patch onto a page moduleId. */
function updateBatch(
  bridgeId: string,
  moduleId: string,
  data: Record<string, unknown>,
): MessageEnvelope {
  return { type: 'ub', target: 'render', body: { bridgeId, updates: [{ moduleId, data }] } }
}

/** A non-AppData message: decodeWorkerMessage returns null → ignored. */
function nonAppData(bridgeId: string): MessageEnvelope {
  return { type: 'u', target: 'render', body: { bridgeId } }
}

/** Pull the snapshot argument of the most recent host.send(Event, snapshot). */
function lastPushed(host: Electron.WebContents): AppDataSnapshot {
  const send = host.send as unknown as ReturnType<typeof vi.fn>
  const calls = send.mock.calls.filter((c) => c[0] === SimulatorAppDataChannel.Event)
  if (calls.length === 0) throw new Error('host.send was never called with the Event channel')
  return calls[calls.length - 1]![1] as AppDataSnapshot
}

function eventSendCount(host: Electron.WebContents): number {
  const send = host.send as unknown as ReturnType<typeof vi.fn>
  return send.mock.calls.filter((c) => c[0] === SimulatorAppDataChannel.Event).length
}

beforeEach(() => {
  ipcHandlers.clear()
  ipcMainStub.handle.mockClear()
  ipcMainStub.removeHandler.mockClear()
  // The PUSH channel now coalesces (see PUSH_COALESCE_MS) — tests that assert
  // on a push must advance past the window themselves.
  vi.useFakeTimers()
})

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('setupSimulatorAppData — registration', () => {
  it('registers ipcMain.handle for GetSnapshot and returns a Disposable', () => {
    const svc = setupSimulatorAppData(makeHost(), { getActiveAppId: () => APP })
    expect(ipcMainStub.handle).toHaveBeenCalledWith(
      SimulatorAppDataChannel.GetSnapshot,
      expect.any(Function),
    )
    expect(typeof svc.dispose).toBe('function')
    void svc.dispose()
  })
})

describe('setupSimulatorAppData — onServiceToRender (decode + accumulate + push)', () => {
  it('pushes a snapshot whose entries reflect init→ub merged data and bridges include the bridge', () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    svc.onServiceToRender(APP, pageInit('b1', 'pages/index/index', { count: 0 }))
    svc.onServiceToRender(APP, updateBatch('b1', 'page_1', { count: 5 }))
    vi.advanceTimersByTime(PUSH_COALESCE_MS)

    const snap = lastPushed(host)
    // bridge recorded with its page route
    expect(snap.bridges).toEqual([{ id: 'b1', pagePath: 'pages/index/index' }])
    // ub merged onto init under the componentPath display key
    expect(snap.entries.b1!['pages/index/index']).toEqual({ count: 5 })

    void svc.dispose()
  })

  it('does NOT call host.send for a non-active appId', () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    svc.onServiceToRender(OTHER, pageInit('b9', 'pages/other/other', { n: 1 }))

    expect(eventSendCount(host)).toBe(0)
    void svc.dispose()
  })

  it('keeps separate accumulators per appId (non-active app accumulates without leaking into active push)', () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    // Feed the OTHER (non-active) app — no push, and must not appear in the
    // active app's snapshot.
    svc.onServiceToRender(OTHER, pageInit('bOther', 'pages/other/other', { n: 1 }))
    // Now feed the active app — its snapshot should contain only its own bridge.
    svc.onServiceToRender(APP, pageInit('b1', 'pages/index/index', { count: 0 }))
    vi.advanceTimersByTime(PUSH_COALESCE_MS)

    const snap = lastPushed(host)
    expect(snap.bridges.map((b) => b.id)).toEqual(['b1'])
    expect(snap.entries.bOther).toBeUndefined()
    void svc.dispose()
  })

  it('does NOT call host.send for a non-AppData message (decode → null → no mutation)', () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    svc.onServiceToRender(APP, nonAppData('b1'))

    expect(eventSendCount(host)).toBe(0)
    void svc.dispose()
  })

  it('does NOT call host.send when the host is destroyed', () => {
    const host = makeHost()
    ;(host.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true)
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    svc.onServiceToRender(APP, pageInit('b1', 'pages/index/index', { count: 0 }))

    expect(host.send).not.toHaveBeenCalled()
    void svc.dispose()
  })
})

describe('setupSimulatorAppData — GetSnapshot (pull)', () => {
  it("returns the active app's accumulator.snapshot() with accumulated data", () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    svc.onServiceToRender(APP, pageInit('b1', 'pages/index/index', { count: 0 }))
    svc.onServiceToRender(APP, updateBatch('b1', 'page_1', { count: 7 }))

    const result = getHandler(SimulatorAppDataChannel.GetSnapshot)({}) as AppDataSnapshot
    expect(result.bridges).toEqual([{ id: 'b1', pagePath: 'pages/index/index' }])
    expect(result.entries.b1!['pages/index/index']).toEqual({ count: 7 })
    void svc.dispose()
  })

  it('returns an EMPTY snapshot { bridges: [], entries: {} } when the active app has no data', () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    const result = getHandler(SimulatorAppDataChannel.GetSnapshot)({})
    expect(result).toEqual({ bridges: [], entries: {} })
    void svc.dispose()
  })
})

describe('setupSimulatorAppData — evictBridge', () => {
  it('removes the bridge from the snapshot and pushes the update when active', () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    svc.onServiceToRender(APP, pageInit('b1', 'pages/index/index', { count: 0 }))
    svc.onServiceToRender(APP, pageInit('b2', 'pages/list/list', { items: [] }))
    // Settle the setup pushes so `before` reflects a steady state, not the
    // (still-pending, coalesced) push from the two onServiceToRender calls.
    vi.advanceTimersByTime(PUSH_COALESCE_MS)

    const before = eventSendCount(host)
    svc.evictBridge(APP, 'b1')
    vi.advanceTimersByTime(PUSH_COALESCE_MS)

    // A fresh push happened…
    expect(eventSendCount(host)).toBe(before + 1)
    // …and b1 is gone while b2 remains.
    const snap = lastPushed(host)
    expect(snap.bridges.map((b) => b.id)).toEqual(['b2'])
    expect(snap.entries.b1).toBeUndefined()
    void svc.dispose()
  })
})

describe('setupSimulatorAppData — push throttling (PUSH_COALESCE_MS)', () => {
  it('does not push synchronously — a single setData only flushes once the window elapses', () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    svc.onServiceToRender(APP, pageInit('b1', 'pages/index/index', { count: 0 }))
    expect(eventSendCount(host)).toBe(0)

    vi.advanceTimersByTime(PUSH_COALESCE_MS)
    expect(eventSendCount(host)).toBe(1)
    expect(lastPushed(host).entries.b1!['pages/index/index']).toEqual({ count: 0 })
    void svc.dispose()
  })

  it('throttles a high-frequency setData burst — later calls in the same window never push the flush deadline out, and the last send carries the latest state', () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    svc.onServiceToRender(APP, pageInit('b1', 'pages/index/index', { count: 0 }))
    // A storm of rapid-fire updates, each well inside the throttle window —
    // only the first call (re)starts the timer; the rest just update which
    // value the eventual flush reads. The storm spans ~500ms, more than one
    // PUSH_COALESCE_MS (300ms) window, so it must not be starved down to a
    // single send the way a pure debounce would be.
    for (let i = 1; i <= 500; i++) {
      svc.onServiceToRender(APP, updateBatch('b1', 'page_1', { count: i }))
      vi.advanceTimersByTime(1)
    }
    // Flush whatever trailing timer is still pending for the tail of the storm.
    vi.advanceTimersByTime(PUSH_COALESCE_MS)

    const sendCount = eventSendCount(host)
    expect(sendCount).toBeGreaterThanOrEqual(2)
    // …and the LAST send carries the final value, not a stale intermediate one.
    expect(lastPushed(host).entries.b1!['pages/index/index']).toEqual({ count: 500 })
    void svc.dispose()
  })

  it('does not withhold pushes indefinitely during a sustained update stream (e.g. a countdown ticking every 50ms)', () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    svc.onServiceToRender(APP, pageInit('b1', 'pages/index/index', { count: 0 }))
    // Updates arrive every 50ms — well inside PUSH_COALESCE_MS (300ms) — for
    // 2 seconds straight. A pure trailing-edge debounce would reset the timer
    // on every tick and never fire until the stream stops; the throttled
    // implementation must still flush at least once per window.
    const INTERVAL_MS = 50
    const TOTAL_MS = 2000
    for (let elapsed = INTERVAL_MS; elapsed <= TOTAL_MS; elapsed += INTERVAL_MS) {
      vi.advanceTimersByTime(INTERVAL_MS)
      svc.onServiceToRender(APP, updateBatch('b1', 'page_1', { count: elapsed }))
    }

    // 2000ms / 300ms window ⇒ at least 6 flushes; assert a conservative floor.
    expect(eventSendCount(host)).toBeGreaterThanOrEqual(5)
    void svc.dispose()
  })

  it('re-checks the active app at flush time — a push scheduled while active is dropped if the active app changed before the window elapsed', () => {
    const host = makeHost()
    let active: string | null = APP
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => active })

    svc.onServiceToRender(APP, pageInit('b1', 'pages/index/index', { count: 0 }))
    active = OTHER

    vi.advanceTimersByTime(PUSH_COALESCE_MS)

    expect(eventSendCount(host)).toBe(0)
    void svc.dispose()
  })

  it('cancels a pending push on dispose — no post-dispose send', () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    svc.onServiceToRender(APP, pageInit('b1', 'pages/index/index', { count: 0 }))
    void svc.dispose()

    vi.advanceTimersByTime(PUSH_COALESCE_MS)

    expect(eventSendCount(host)).toBe(0)
  })
})

describe('setupSimulatorAppData — getPageData (active app reactive page data)', () => {
  it("returns the active app's accumulator.pageData(bridgeId) (init→ub merged)", () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    svc.onServiceToRender(APP, pageInit('b1', 'pages/index/index', { count: 0, title: 'hi' }))
    svc.onServiceToRender(APP, updateBatch('b1', 'page_1', { count: 9 }))

    expect(svc.getPageData('b1')).toEqual({ count: 9, title: 'hi' })
    void svc.dispose()
  })

  it('returns {} when the bridge belongs to a different (non-active) app', () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    // Feed the OTHER (non-active) app — its bridge must NOT be visible via the
    // active app's getPageData.
    svc.onServiceToRender(OTHER, pageInit('bOther', 'pages/other/other', { n: 1 }))

    expect(svc.getPageData('bOther')).toEqual({})
    void svc.dispose()
  })

  it('reads from whichever app is active when getActiveAppId switches', () => {
    const host = makeHost()
    let active: string | null = APP
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => active })

    svc.onServiceToRender(APP, pageInit('b1', 'pages/index/index', { who: 'app' }))
    svc.onServiceToRender(OTHER, pageInit('b1', 'pages/other/other', { who: 'other' }))

    // APP active → APP's b1
    expect(svc.getPageData('b1')).toEqual({ who: 'app' })
    // switch active → OTHER's b1
    active = OTHER
    expect(svc.getPageData('b1')).toEqual({ who: 'other' })
    void svc.dispose()
  })

  it('returns {} when there is no active app (getActiveAppId null)', () => {
    const host = makeHost()
    let active: string | null = APP
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => active })

    svc.onServiceToRender(APP, pageInit('b1', 'pages/index/index', { count: 0 }))

    active = null
    expect(svc.getPageData('b1')).toEqual({})
    void svc.dispose()
  })

  it('returns {} when the active app has no accumulator / no data', () => {
    const host = makeHost()
    const svc = setupSimulatorAppData(host, { getActiveAppId: () => APP })

    // No messages fed for APP → no data for any bridge.
    expect(svc.getPageData('b1')).toEqual({})
    void svc.dispose()
  })
})

describe('setupSimulatorAppData — dispose', () => {
  it('removes the GetSnapshot IPC handler', () => {
    const svc = setupSimulatorAppData(makeHost(), { getActiveAppId: () => APP })
    expect(ipcHandlers.has(SimulatorAppDataChannel.GetSnapshot)).toBe(true)

    void svc.dispose()

    expect(ipcMainStub.removeHandler).toHaveBeenCalledWith(SimulatorAppDataChannel.GetSnapshot)
    expect(ipcHandlers.has(SimulatorAppDataChannel.GetSnapshot)).toBe(false)
  })
})

// ── SetData (renderer edit write-back) ─────────────────────────────────────
//
// The panel edits a value and the change must reach the running page: main
// resolves the owning service-host WebContents via `options.bridge.getServiceWcForBridge`
// and forwards `{ bridgeId, data }` over `ServiceHostChannel.AppDataSetData`. The
// service-host preload (out of scope here) applies it via `page.setData(data)`.
//
// `SimulatorAppDataChannel.SetData`, `ServiceHostChannel.AppDataSetData` and
// `SimulatorAppDataOptions.bridge` are frozen contract members this suite pins
// but does not yet declare on the source types — read through untyped views so
// the suite type-checks against today's narrower types while still exercising
// the real runtime object (undefined channel key / excess-property rejection
// are exactly the "not implemented yet" signal these tests are meant to fail on).
const untypedAppDataChannel = SimulatorAppDataChannel as Record<string, string>
const untypedServiceHostChannel = ServiceHostChannel as Record<string, string>
const SET_DATA_CHANNEL = untypedAppDataChannel.SetData as unknown as string
const APPDATA_SET_DATA_CHANNEL = untypedServiceHostChannel.AppDataSetData as unknown as string
const APPDATA_SET_DATA_RESULT_CHANNEL = untypedServiceHostChannel.AppDataSetDataResult as unknown as string

/** A bridge accessor stub resolving a fixed WebContents (or null) for any bridgeId. */
function makeBridge(wc: Electron.WebContents | null) {
  return { getServiceWcForBridge: vi.fn((_bridgeId: string) => wc) }
}

/** Builds options with a `bridge` accessor not yet declared on SimulatorAppDataOptions. */
function optionsWithBridge(
  bridge: ReturnType<typeof makeBridge>,
): Parameters<typeof setupSimulatorAppData>[1] {
  return { getActiveAppId: () => APP, bridge } as unknown as Parameters<
    typeof setupSimulatorAppData
  >[1]
}

const VALID_SET_DATA_PAYLOAD = { bridgeId: 'b1', data: { count: 1 } }

describe('setupSimulatorAppData — SetData (registration)', () => {
  it('registers ipcMain.handle for SetData regardless of whether options.bridge is provided', () => {
    const svc = setupSimulatorAppData(makeHost(), { getActiveAppId: () => APP })
    expect(ipcMainStub.handle).toHaveBeenCalledWith(SET_DATA_CHANNEL, expect.any(Function))
    void svc.dispose()
  })
})

describe('setupSimulatorAppData — SetData (forwarding a valid edit)', () => {
  it('accepts an acknowledgement from the bridge owner outside the renderer whitelist', async () => {
    const host = makeHost()
    const serviceWc = makeHost()
    const svc = setupSimulatorAppData(host, {
      ...optionsWithBridge(makeBridge(serviceWc)),
      senderPolicy: sender => sender === host,
    })
    const pending = getHandler(SET_DATA_CHANNEL)({ sender: host }, VALID_SET_DATA_PAYLOAD) as Promise<boolean>
    emit(APPDATA_SET_DATA_RESULT_CHANNEL, serviceWc, { id: 1, bridgeId: 'b1', applied: true })
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(pending).resolves.toBe(true)
    void svc.dispose()
  })

  it('does not report success before the service host acknowledges the actual page.setData result', async () => {
    const serviceWc = makeHost()
    const svc = setupSimulatorAppData(makeHost(), optionsWithBridge(makeBridge(serviceWc)))
    let settled: boolean | undefined
    const pending = getHandler(SET_DATA_CHANNEL)({}, VALID_SET_DATA_PAYLOAD) as Promise<boolean>
    expect(pending).toBeInstanceOf(Promise)
    void pending.then((value) => { settled = value })

    await Promise.resolve()
    expect(settled).toBeUndefined()
    emit(APPDATA_SET_DATA_RESULT_CHANNEL, serviceWc, { id: 1, bridgeId: 'b1', applied: true })
    await expect(pending).resolves.toBe(true)
    void svc.dispose()
  })

  it("resolves the bridge's service WebContents and returns its applied acknowledgement", async () => {
    const serviceWc = makeHost()
    const bridge = makeBridge(serviceWc)
    const svc = setupSimulatorAppData(makeHost(), optionsWithBridge(bridge))

    const pending = getHandler(SET_DATA_CHANNEL)({}, VALID_SET_DATA_PAYLOAD) as Promise<boolean>

    expect(bridge.getServiceWcForBridge).toHaveBeenCalledWith('b1')
    expect(serviceWc.send).toHaveBeenCalledWith(APPDATA_SET_DATA_CHANNEL, {
      id: 1,
      bridgeId: 'b1',
      data: { count: 1 },
    })
    emit(APPDATA_SET_DATA_RESULT_CHANNEL, serviceWc, { id: 1, bridgeId: 'b1', applied: true })
    const result = await pending
    expect(result).toBe(true)
    void svc.dispose()
  })

  it('rejects a false acknowledgement and ignores a spoofed sender before the owner replies', async () => {
    const serviceWc = makeHost()
    const svc = setupSimulatorAppData(makeHost(), optionsWithBridge(makeBridge(serviceWc)))
    const pending = getHandler(SET_DATA_CHANNEL)({}, VALID_SET_DATA_PAYLOAD) as Promise<boolean>
    emit(APPDATA_SET_DATA_RESULT_CHANNEL, makeHost(), { id: 1, bridgeId: 'b1', applied: true })
    emit(APPDATA_SET_DATA_RESULT_CHANNEL, serviceWc, { id: 1, bridgeId: 'b1', applied: false })
    await expect(pending).resolves.toBe(false)
    void svc.dispose()
  })

  it('resolves a pending write false when its bridge is evicted before the acknowledgement', async () => {
    const serviceWc = makeHost()
    const svc = setupSimulatorAppData(makeHost(), optionsWithBridge(makeBridge(serviceWc)))
    const pending = getHandler(SET_DATA_CHANNEL)({}, VALID_SET_DATA_PAYLOAD) as Promise<boolean>
    svc.evictBridge(APP, 'b1')
    await expect(pending).resolves.toBe(false)
    emit(APPDATA_SET_DATA_RESULT_CHANNEL, serviceWc, { id: 1, bridgeId: 'b1', applied: true })
    void svc.dispose()
  })

  it('resolves a pending write false and removes its listener when the service WebContents is destroyed', async () => {
    const serviceWc = makeHost()
    const svc = setupSimulatorAppData(makeHost(), optionsWithBridge(makeBridge(serviceWc)))
    const pending = getHandler(SET_DATA_CHANNEL)({}, VALID_SET_DATA_PAYLOAD) as Promise<boolean>
    ;(serviceWc as unknown as { emit(event: string): void }).emit('destroyed')
    await expect(pending).resolves.toBe(false)
    expect(serviceWc.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function))
    void svc.dispose()
  })

  it('resolves a pending write false on service disposal', async () => {
    const serviceWc = makeHost()
    const svc = setupSimulatorAppData(makeHost(), optionsWithBridge(makeBridge(serviceWc)))
    const pending = getHandler(SET_DATA_CHANNEL)({}, VALID_SET_DATA_PAYLOAD) as Promise<boolean>
    await svc.dispose()
    await expect(pending).resolves.toBe(false)
  })

  it('uses the actual service page.setData helper result as the main-process acknowledgement', async () => {
    const serviceWc = makeHost()
    const setData = vi.fn()
    const svc = setupSimulatorAppData(makeHost(), optionsWithBridge(makeBridge(serviceWc)))
    const pending = getHandler(SET_DATA_CHANNEL)({}, VALID_SET_DATA_PAYLOAD) as Promise<boolean>
    const sent = (serviceWc.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { id: number; bridgeId: string; data: Record<string, unknown> }
    const applied = applyAppDataSetData(() => [{ bridgeId: 'b1', setData }], sent.bridgeId, sent.data)
    emit(APPDATA_SET_DATA_RESULT_CHANNEL, serviceWc, { id: sent.id, bridgeId: sent.bridgeId, applied })
    await expect(pending).resolves.toBe(true)
    expect(setData).toHaveBeenCalledWith({ count: 1 })
    void svc.dispose()
  })

  it('returns false immediately when service send throws', async () => {
    const serviceWc = makeHost()
    ;(serviceWc.send as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('gone') })
    const svc = setupSimulatorAppData(makeHost(), optionsWithBridge(makeBridge(serviceWc)))
    await expect(getHandler(SET_DATA_CHANNEL)({}, VALID_SET_DATA_PAYLOAD)).resolves.toBe(false)
    expect(serviceWc.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function))
    void svc.dispose()
  })

  it('times out a lost acknowledgement and returns its timer/listener ledger to baseline', async () => {
    const serviceWc = makeHost()
    const svc = setupSimulatorAppData(makeHost(), optionsWithBridge(makeBridge(serviceWc)))
    const pending = getHandler(SET_DATA_CHANNEL)({}, VALID_SET_DATA_PAYLOAD) as Promise<boolean>
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(pending).resolves.toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(serviceWc.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function))
    void svc.dispose()
  })

  it('returns false and sends nothing when options.bridge is not provided', async () => {
    const svc = setupSimulatorAppData(makeHost(), { getActiveAppId: () => APP })

    const result = await getHandler(SET_DATA_CHANNEL)({}, VALID_SET_DATA_PAYLOAD)

    expect(result).toBe(false)
    void svc.dispose()
  })

  it('returns false when getServiceWcForBridge resolves no WebContents for the bridgeId', async () => {
    const bridge = makeBridge(null)
    const svc = setupSimulatorAppData(makeHost(), optionsWithBridge(bridge))

    const result = await getHandler(SET_DATA_CHANNEL)({}, VALID_SET_DATA_PAYLOAD)

    expect(result).toBe(false)
    void svc.dispose()
  })

  it('returns false without sending when the resolved service WebContents is destroyed', async () => {
    const serviceWc = makeHost()
    ;(serviceWc.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true)
    const bridge = makeBridge(serviceWc)
    const svc = setupSimulatorAppData(makeHost(), optionsWithBridge(bridge))

    const result = await getHandler(SET_DATA_CHANNEL)({}, VALID_SET_DATA_PAYLOAD)

    expect(result).toBe(false)
    expect(serviceWc.send).not.toHaveBeenCalled()
    void svc.dispose()
  })
})

describe('setupSimulatorAppData — SetData (payload validation)', () => {
  it.each([
    ['undefined payload', undefined],
    ['null payload', null],
    ['string payload', 'nope'],
    ['array payload', ['x']],
    ['missing bridgeId', { data: { a: 1 } }],
    ['empty-string bridgeId', { bridgeId: '', data: { a: 1 } }],
    ['non-string bridgeId', { bridgeId: 42, data: { a: 1 } }],
    ['missing data', { bridgeId: 'b1' }],
    ['array data', { bridgeId: 'b1', data: ['x'] }],
    ['null data', { bridgeId: 'b1', data: null }],
    ['empty-object data', { bridgeId: 'b1', data: {} }],
  ])('rejects an invalid payload (%s) — returns false, sends nothing', async (_label, payload) => {
    const serviceWc = makeHost()
    const bridge = makeBridge(serviceWc)
    const svc = setupSimulatorAppData(makeHost(), optionsWithBridge(bridge))

    const result = await getHandler(SET_DATA_CHANNEL)({}, payload)

    expect(result).toBe(false)
    expect(serviceWc.send).not.toHaveBeenCalled()
    void svc.dispose()
  })
})

describe('setupSimulatorAppData — SetData (dispose)', () => {
  it('removes the SetData IPC handler alongside GetSnapshot', () => {
    const svc = setupSimulatorAppData(makeHost(), { getActiveAppId: () => APP })
    expect(ipcHandlers.has(SET_DATA_CHANNEL)).toBe(true)

    void svc.dispose()

    expect(ipcMainStub.removeHandler).toHaveBeenCalledWith(SET_DATA_CHANNEL)
    expect(ipcHandlers.has(SET_DATA_CHANNEL)).toBe(false)
  })
})
