import { afterEach, beforeEach, vi } from 'vitest'
import { fireServiceDidFinishLoad } from './bridge-router-boot-test-fixtures.js'

const electron = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const listeners = new Map<string, Listener[]>()
  const sync = {
    on(channel: string, fn: Listener) { const list = listeners.get(channel) ?? []; list.push(fn); listeners.set(channel, list) },
    removeListener(channel: string, fn: Listener) { const list = listeners.get(channel); const at = list?.indexOf(fn) ?? -1; if (at >= 0) list!.splice(at, 1) },
    emit(channel: string, ...args: unknown[]) { for (const fn of [...(listeners.get(channel) ?? [])]) fn(...args) },
    clear() { listeners.clear() },
  }
  const ipcMain = {
    handle(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) { if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`); handlers.set(channel, fn) },
    removeHandler(channel: string) { handlers.delete(channel) },
    on(channel: string, fn: Listener) { sync.on(channel, fn); return ipcMain },
    removeListener(channel: string, fn: Listener) { sync.removeListener(channel, fn); return ipcMain },
    listenerCount(channel: string) { return listeners.get(channel)?.length ?? 0 },
  }
  const protocolStub = { handle: vi.fn(), unhandle: vi.fn(), registerSchemesAsPrivileged: vi.fn() }
  const fromPartition = () => ({ protocol: { handle: vi.fn(), unhandle: vi.fn(), registerSchemesAsPrivileged: vi.fn() }, setPermissionRequestHandler: vi.fn(), webRequest: { onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() } })
  return { handlers, sync, ipcMain, protocolStub, fromPartition }
})

export interface FakeWc {
  id: number
  isDestroyed(): boolean
  send: ((...args: unknown[]) => unknown) & { mock: { calls: unknown[][] } }
  on: (...args: unknown[]) => unknown
  once: ((...args: unknown[]) => unknown) & { mock: { calls: unknown[][] } }
  removeListener: (...args: unknown[]) => unknown
  listenerCount: (...args: unknown[]) => number
  executeJavaScript: (...args: unknown[]) => Promise<unknown>
  close: (...args: unknown[]) => unknown
  hostWebContents?: unknown
}
interface Fakes { makeWc(host?: unknown): FakeWc; windows: Array<{ webContents: FakeWc }>; createWindow(): unknown; own(wc: FakeWc, cleanup: () => void): void; destroyOwned(wc: FakeWc): void; reset(): void }
const fakes: Fakes = vi.hoisted(() => {
  let nextId = 1
  const owned = new Map<number, () => void>()
  const makeWc = (hostWebContents?: unknown) => ({ id: nextId++, isDestroyed: () => false, send: vi.fn(), on: vi.fn(), once: vi.fn(), removeListener: vi.fn(), listenerCount: vi.fn(() => 0), executeJavaScript: vi.fn(() => Promise.resolve()), close: vi.fn(), hostWebContents }) as unknown as FakeWc
  const windows: Array<{ webContents: ReturnType<typeof makeWc> }> = []
  const createWindow = () => { const win = { webContents: makeWc(), isDestroyed: () => false, close: vi.fn(), on: vi.fn(), once: vi.fn(), removeListener: vi.fn() }; windows.push(win); return win }
  return {
    makeWc, windows, createWindow,
    own: (wc: { id: number }, cleanup: () => void) => owned.set(wc.id, cleanup),
    destroyOwned: (wc: { id: number }) => owned.get(wc.id)?.(),
    reset: () => { nextId = 1; windows.length = 0; owned.clear() },
  }
})

vi.mock('electron', () => ({ app: { isReady: () => true, on: vi.fn(), getLocale: () => 'zh-CN' }, BrowserWindow: class {}, ipcMain: electron.ipcMain, protocol: electron.protocolStub, session: { fromPartition: electron.fromPartition }, webContents: { fromId: () => null, getAllWebContents: () => [] }, default: {} }))
vi.mock('../services/dmb-resource/handle-request.js', () => ({ handleDmbResourceRequest: () => Promise.resolve(new Response('')) }))
vi.mock('../windows/service-host-window/create.js', () => ({ createServiceHostWindow: () => fakes.createWindow(), navigateServiceHost: () => Promise.resolve(), buildServiceHostSpawnUrl: () => 'file:///service.html', serviceHostSpec: () => ({}) }))

import { BRIDGE_CHANNELS as C, SIMULATOR_EVENTS as E } from '../../shared/bridge-channels.js'
import type { MessageEnvelope, PageOpenResult, SpawnResult } from '../../shared/bridge-channels.js'
import { __resetMiniappSessionConfigForTests } from '../services/views/miniapp-partition.js'
import { installBridgeRouter } from './bridge-router.js'
import type { RuntimeContext } from '../runtime-context.js'

export { C, E }
export const makeFakeWc = (): FakeWc => fakes.makeWc()
export const destroyOwnedGuest = (wc: FakeWc): void => fakes.destroyOwned(wc)
export const ROOT_PAGE = 'pages/index/index'
export const DETAIL_PAGE = 'pages/detail/detail'
const config = { app: { entryPagePath: ROOT_PAGE, pages: [ROOT_PAGE, DETAIL_PAGE] }, modules: {} }

class Registry {
  disposers: Array<() => unknown> = []
  add(value: { dispose(): unknown } | (() => unknown)) { const dispose = typeof value === 'function' ? value : () => value.dispose(); this.disposers.push(dispose); return { dispose } }
  async dispose() { for (const dispose of this.disposers.reverse()) await dispose(); this.disposers.length = 0 }
}
const registries: Registry[] = []

export function makeCtx(): { ctx: RuntimeContext; simulatorWc: FakeWc } {
  const windowWc = fakes.makeWc(); const simulatorWc = fakes.makeWc(windowWc); const registry = new Registry(); registries.push(registry)
  const ctx = {
    apiNamespaces: [], assets: { root: '/runtime/dist', simulatorDir: '/runtime/dist/simulator', simulatorPreloadPath: '/runtime/dist/preload/simulator.cjs', renderHostHtmlPath: '/runtime/dist/render-host/pageFrame.html', renderHostPreloadPath: '/runtime/dist/render-host/preload.cjs', serviceHostHtmlPath: '/runtime/dist/service-host/service.html', serviceHostPreloadPath: '/runtime/dist/service-host/preload.cjs' },
    workspace: { getSession: () => null, getProjectPath: () => '/project', isClosing: () => false },
    windows: { mainWindow: { webContents: windowWc, isDestroyed: () => false, contentView: { children: [] }, on: vi.fn(), off: vi.fn(), removeListener: vi.fn() } }, registry,
    connections: { acquire: (wc: FakeWc) => ({ own: (cleanup: () => void) => fakes.own(wc, cleanup) }), get: vi.fn(), reset: vi.fn() }, simulatorApis: { invoke: vi.fn(), list: () => [], has: () => false }, events: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
  } as unknown as RuntimeContext
  return { ctx, simulatorWc }
}

export function install(ctx: RuntimeContext) { installBridgeRouter(ctx); return ctx.bridge! }
export function invokeHandler(channel: string, sender: FakeWc, payload: unknown): Promise<unknown> { const handler = electron.handlers.get(channel); if (!handler) throw new Error(`no handler on ${channel}`); return Promise.resolve(handler({ sender }, payload)) }
export function emitSync(channel: string, sender: FakeWc, payload: unknown): void { electron.sync.emit(channel, { sender }, payload) }
export function sendsOn(wc: FakeWc, channel: string): unknown[] { return wc.send.mock.calls.filter((call: unknown[]) => call[0] === channel).map((call: unknown[]) => call[1]) }
export function serviceCallbacks(wc: FakeWc): Array<{ id: unknown; args: unknown }> { return sendsOn(wc, C.TO_SERVICE).map(value => (value as { msg: MessageEnvelope }).msg).filter(msg => msg.type === 'triggerCallback').map(msg => msg.body as { id: unknown; args: unknown }) }
export function serviceInvokeApi(wc: FakeWc, body: Record<string, unknown>): void { emitSync(C.SERVICE_INVOKE, wc, { msg: { type: 'invokeAPI', target: 'container', body } }) }
export function announceRenderGuest(wc: FakeWc, bridgeId: string): void { emitSync(C.RENDER_INVOKE, wc, { bridgeId, msg: { type: 'renderHostReady', target: 'container', body: { bridgeId } } }) }

export interface RootSession { simulatorWc: FakeWc; serviceWc: FakeWc; rootBridgeId: string; rootRenderWc: FakeWc; appSessionId: string }
export async function spawnRoot(simulatorWc: FakeWc, appId: string, extraOpts: Record<string, unknown> = {}): Promise<RootSession> {
  const spawn = await invokeHandler(C.SPAWN, simulatorWc, { appId, pagePath: ROOT_PAGE, resourceBaseUrl: 'http://127.0.0.1:65535/', ...extraOpts }) as SpawnResult
  const serviceWc = fakes.windows.at(-1)!.webContents; fireServiceDidFinishLoad(serviceWc)
  const rootRenderWc = fakes.makeWc(); announceRenderGuest(rootRenderWc, spawn.bridgeId)
  return { simulatorWc, serviceWc, rootBridgeId: spawn.bridgeId, rootRenderWc, appSessionId: spawn.appSessionId }
}
export interface TwoPageSession extends RootSession { detailBridgeId: string; detailRenderWc: FakeWc }
export async function bootTwoPageSession(): Promise<TwoPageSession> {
  const { ctx, simulatorWc } = makeCtx(); install(ctx); const root = await spawnRoot(simulatorWc, 'app-1')
  const opened = await invokeHandler(C.PAGE_OPEN, simulatorWc, { appSessionId: root.appSessionId, pagePath: DETAIL_PAGE }) as PageOpenResult
  const detailRenderWc = fakes.makeWc(); announceRenderGuest(detailRenderWc, opened.bridgeId); emitSync(C.ACTIVE_PAGE, simulatorWc, { appSessionId: root.appSessionId, bridgeId: opened.bridgeId })
  return { ...root, detailBridgeId: opened.bridgeId, detailRenderWc }
}
export function closeRootPage(s: RootSession): void { emitSync(C.PAGE_CLOSE, s.simulatorWc, { bridgeId: s.rootBridgeId }) }
export async function bootRootOnlySession(appId = 'app-1', extraOpts: Record<string, unknown> = {}) { const { ctx, simulatorWc } = makeCtx(); install(ctx); return spawnRoot(simulatorWc, appId, extraOpts) }
export async function bootTwoIndependentSessions() { const { ctx, simulatorWc } = makeCtx(); install(ctx); return { a: await spawnRoot(simulatorWc, 'app-1'), b: await spawnRoot(simulatorWc, 'app-2') } }
export interface ReLaunchGapSession { serviceWc: FakeWc; rootRenderWc: FakeWc; newBridgeId: string; newRenderWc: FakeWc }
export async function bootReLaunchGapSession(): Promise<ReLaunchGapSession> {
  const { ctx, simulatorWc } = makeCtx(); install(ctx); const root = await spawnRoot(simulatorWc, 'app-1')
  const opened = await invokeHandler(C.PAGE_OPEN, simulatorWc, { appSessionId: root.appSessionId, pagePath: DETAIL_PAGE }) as PageOpenResult
  const newRenderWc = fakes.makeWc(); announceRenderGuest(newRenderWc, opened.bridgeId); emitSync(C.PAGE_CLOSE, simulatorWc, { bridgeId: root.rootBridgeId })
  return { serviceWc: root.serviceWc, rootRenderWc: root.rootRenderWc, newBridgeId: opened.bridgeId, newRenderWc }
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(config))))))
afterEach(async () => { for (const registry of registries.splice(0)) await registry.dispose(); electron.handlers.clear(); electron.sync.clear(); electron.protocolStub.handle.mockClear(); electron.protocolStub.unhandle.mockClear(); fakes.reset(); vi.unstubAllGlobals(); __resetMiniappSessionConfigForTests() })
