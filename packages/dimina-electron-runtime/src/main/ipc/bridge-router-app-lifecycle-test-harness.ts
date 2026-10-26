import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import { fireServiceDidFinishLoad } from './bridge-router-boot-test-fixtures.js'

/**
 * Shared `installBridgeRouter` setup for the host hide/show lifecycle suites:
 * electron/service-host/native-websocket stubs plus a fake main window whose
 * `minimize`/`hide`/`restore`/`show` events drive `installAppLifecycleDriver`.
 * Importing this module registers the mocks and the per-test reset hooks.
 */
const electronStubs = vi.hoisted(() => {
  type SyncListener = (...args: unknown[]) => void
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const syncListeners = new Map<string, SyncListener[]>()
  const sync = {
    on(channel: string, listener: SyncListener) {
      const list = syncListeners.get(channel) ?? []
      list.push(listener)
      syncListeners.set(channel, list)
    },
    removeListener(channel: string, listener: SyncListener) {
      const list = syncListeners.get(channel)
      if (!list) return
      const at = list.indexOf(listener)
      if (at !== -1) list.splice(at, 1)
    },
    listenerCount: (channel: string) => syncListeners.get(channel)?.length ?? 0,
    emit(channel: string, ...args: unknown[]) {
      for (const listener of [...(syncListeners.get(channel) ?? [])]) listener(...args)
    },
    removeAllListeners() {
      syncListeners.clear()
    },
  }
  const ipcMain = {
    handle(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) {
      if (handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      }
      handlers.set(channel, fn)
    },
    removeHandler(channel: string) {
      handlers.delete(channel)
    },
    on(channel: string, listener: (...args: unknown[]) => void) {
      sync.on(channel, listener)
      return ipcMain
    },
    removeListener(channel: string, listener: (...args: unknown[]) => void) {
      sync.removeListener(channel, listener)
      return ipcMain
    },
    listenerCount: (channel: string) => sync.listenerCount(channel),
  }
  const makeProtocolStub = () => ({
    handle: vi.fn(),
    unhandle: vi.fn(),
    registerSchemesAsPrivileged: vi.fn(),
  })
  const protocolStub = makeProtocolStub()
  const fromPartition = () => ({
    protocol: makeProtocolStub(),
    setPermissionRequestHandler: vi.fn(),
    webRequest: { onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() },
  })
  return { handlers, sync, ipcMain, protocolStub, fromPartition }
})

vi.mock('electron', () => ({
  app: { isReady: () => true, on: vi.fn(), getLocale: () => 'zh-CN' },
  BrowserWindow: class {},
  ipcMain: electronStubs.ipcMain,
  protocol: electronStubs.protocolStub,
  session: { fromPartition: electronStubs.fromPartition },
  webContents: { fromId: () => null, getAllWebContents: () => [] },
  default: {},
}))

vi.mock('../services/dmb-resource/handle-request.js', () => ({
  handleDmbResourceRequest: () => Promise.resolve(new Response('')),
}))

// Only what the driver and bridge-router-handle installation touch:
// `setBackgrounded` (asserted below) plus the no-op wiring
// `createBridgeRouterHandle` always performs (`setTracer`) and dispose
// (`disposeOwner`/`dispose`). Anything socket-specific (connect/send/close)
// is irrelevant to host-hide/show behavior and left unstubbed on purpose —
// a call into it would surface as a test failure rather than silently pass.
const nativeWebSocketFake: { setBackgrounded: Mock; setTracer: Mock; disposeOwner: Mock; dispose: Mock } = vi.hoisted(() => ({
  setBackgrounded: vi.fn(),
  setTracer: vi.fn(),
  disposeOwner: vi.fn(),
  dispose: vi.fn(),
}))

vi.mock('../services/native-websocket/index.js', () => ({
  createNativeWebSocketService: () => nativeWebSocketFake,
}))

export const setBackgroundedSpy: Mock = nativeWebSocketFake.setBackgrounded

interface FakeWc {
  id: number
  isDestroyed: () => boolean
  send: Mock
  on: Mock
  once: Mock
  removeListener: Mock
  executeJavaScript: Mock
  close: Mock
  hostWebContents: unknown
}

interface Fakes {
  makeWc: (host?: unknown) => FakeWc
  windows: Array<{ webContents: FakeWc }>
  createWindow: () => { webContents: FakeWc }
  reset: () => void
}

const fakes: Fakes = vi.hoisted(() => {
  let nextWcId = 1
  const makeWc = (host?: unknown) => ({
    id: nextWcId++,
    isDestroyed: () => false,
    send: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    executeJavaScript: vi.fn(() => Promise.resolve()),
    close: vi.fn(),
    hostWebContents: host,
  })
  const windows: Array<{ webContents: ReturnType<typeof makeWc> }> = []
  const createWindow = () => {
    const win = {
      webContents: makeWc(),
      isDestroyed: () => false,
      close: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    }
    windows.push(win)
    return win
  }
  const reset = () => {
    nextWcId = 1
    windows.length = 0
  }
  return { makeWc, windows, createWindow, reset }
})

vi.mock('../windows/service-host-window/create.js', () => ({
  createServiceHostWindow: () => fakes.createWindow(),
  navigateServiceHost: () => Promise.resolve(),
  buildServiceHostSpawnUrl: () => 'file:///service.html',
  serviceHostSpec: () => ({}),
}))

import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type { SpawnResult } from '../../shared/bridge-channels.js'
import { __resetMiniappSessionConfigForTests } from '../services/views/miniapp-partition.js'
import { installBridgeRouter } from './bridge-router.js'
import type { RuntimeContext } from '../runtime-context.js'


const ROOT_PAGE = 'pages/index/index'
const SECOND_PAGE = 'pages/second/second'
const APP_CONFIG = { app: { entryPagePath: ROOT_PAGE, pages: [ROOT_PAGE, SECOND_PAGE] }, modules: {} }

class FakeRegistry {
  private readonly disposers: Array<() => unknown> = []
  add(value: { dispose(): unknown } | (() => unknown)) {
    const dispose = typeof value === 'function' ? value : () => value.dispose()
    this.disposers.push(dispose)
    return { dispose }
  }
  async dispose() {
    for (const dispose of this.disposers.reverse()) await dispose()
    this.disposers.length = 0
  }
}

const openRegistries: FakeRegistry[] = []

/** A minimal real EventEmitter for the four events `installAppLifecycleDriver`
 *  listens to, plus `isMinimized()` — Electron's actual `BrowserWindow` semantics
 *  the driver depends on (a `show` while still minimized must NOT foreground). */
function makeMainWindow(): { win: { on: (e: string, l: () => void) => void; off: (e: string, l: () => void) => void; isMinimized: () => boolean }; fire: (event: 'hide' | 'minimize' | 'show' | 'restore') => void; setMinimized: (v: boolean) => void } {
  const listeners = new Map<string, Set<() => void>>()
  let minimized = false
  return {
    win: {
      on: (event, listener) => {
        const set = listeners.get(event) ?? new Set()
        set.add(listener)
        listeners.set(event, set)
      },
      off: (event, listener) => {
        listeners.get(event)?.delete(listener)
      },
      isMinimized: () => minimized,
    },
    fire: (event) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener()
    },
    setMinimized: (v) => { minimized = v },
  }
}

function makeCtx(): { ctx: RuntimeContext; simulatorWc: FakeWc; mainWindow: ReturnType<typeof makeMainWindow> } {
  const windowWc = fakes.makeWc()
  const simulatorWc = fakes.makeWc(windowWc)
  const registry = new FakeRegistry()
  openRegistries.push(registry)
  const mainWindow = makeMainWindow()
  const ctx = {
    apiNamespaces: [],
    assets: {
      root: '/runtime/dist',
      simulatorDir: '/runtime/dist/simulator',
      simulatorPreloadPath: '/runtime/dist/preload/simulator.cjs',
      renderHostHtmlPath: '/runtime/dist/render-host/pageFrame.html',
      renderHostPreloadPath: '/runtime/dist/render-host/preload.cjs',
      serviceHostHtmlPath: '/runtime/dist/service-host/service.html',
      serviceHostPreloadPath: '/runtime/dist/service-host/preload.cjs',
    },
    workspace: {
      getSession: () => null,
      getProjectPath: () => '/project',
      isClosing: () => false,
    },
    windows: {
      mainWindow: {
        webContents: windowWc,
        isDestroyed: () => false,
        contentView: { children: [] },
        ...mainWindow.win,
      },
    },
    registry,
    connections: { acquire: () => ({ own: vi.fn() }), get: vi.fn(), reset: vi.fn() },
    simulatorApis: { invoke: vi.fn(), list: () => [], has: () => false },
    events: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
  } as unknown as RuntimeContext
  return { ctx, simulatorWc, mainWindow }
}

function invokeHandler(channel: string, sender: FakeWc, payload: unknown): Promise<unknown> {
  const handler = electronStubs.handlers.get(channel)
  if (!handler) throw new Error(`no handler on ${channel}`)
  return Promise.resolve(handler({ sender }, payload))
}

function emitSync(channel: string, sender: FakeWc, payload: unknown): void {
  electronStubs.sync.emit(channel, { sender }, payload)
}

interface SentEnvelope {
  type: string
  target: string
  body: unknown
}

/** Every `TO_SERVICE` envelope the fake service webContents received, in arrival order. */
export function toServiceMessages(serviceWc: FakeWc): SentEnvelope[] {
  return serviceWc.send.mock.calls
    .filter((call) => call[0] === C.TO_SERVICE)
    .map((call) => (call[1] as { msg: SentEnvelope }).msg)
}

interface Session {
  ctx: RuntimeContext
  simulatorWc: FakeWc
  serviceWc: FakeWc
  mainWindow: ReturnType<typeof makeMainWindow>
  appSessionId: string
  rootBridgeId: string
}

/**
 * `serviceLoaded` (service's App instance constructed) defaults to true: most
 * cases drive hide/show against an already-fully-ready session. Pass
 * `serviceLoaded: false` to keep a
 * session pending it — see bridge-router-app-visibility-deferral.test.ts.
 *
 * Pass `existing` (an already-booted session's `ctx`/`simulatorWc`/
 * `mainWindow`) to spawn a SECOND app session against the SAME main window
 * and driver instance — e.g. to reproduce "a session spawned while the host
 * is already backgrounded" (`state.hostBackgrounded` carries over from the
 * first session's hide, unlike a fresh `makeCtx()`).
 */
export async function bootRootOnlySession(opts: {
  serviceLoaded?: boolean
  appId?: string
  existing?: { ctx: RuntimeContext; simulatorWc: FakeWc; mainWindow: ReturnType<typeof makeMainWindow> }
} = {}): Promise<Session> {
  const { ctx, simulatorWc, mainWindow } = opts.existing ?? makeCtx()
  if (!opts.existing) installBridgeRouter(ctx)
  const spawn = (await invokeHandler(C.SPAWN, simulatorWc, {
    appId: opts.appId ?? 'app-1',
    pagePath: ROOT_PAGE,
    resourceBaseUrl: 'http://127.0.0.1:65535/',
  })) as SpawnResult
  const serviceWc = fakes.windows[fakes.windows.length - 1]!.webContents
  fireServiceDidFinishLoad(serviceWc)
  const session = { ctx, simulatorWc, serviceWc, mainWindow, appSessionId: spawn.appSessionId, rootBridgeId: spawn.bridgeId }
  if (opts.serviceLoaded ?? true) fireServiceResourceLoaded(session)
  return session
}

/** Marks the session's service App instance as constructed — the point past
 *  which `syncAppVisibility` may actually deliver appShow/appHide/pageShow/
 *  pageHide (see AppSession.appHiddenSent). Mirrors the real
 *  `serviceResourceLoaded` container message a live service host sends once
 *  its entry page's `loadResource` finishes. */
export function fireServiceResourceLoaded(s: Session): void {
  emitSync(C.SERVICE_INVOKE, s.serviceWc, { msg: { type: 'serviceResourceLoaded', target: 'container', body: {} } })
}

export function pageShow(s: Session, bridgeId = s.rootBridgeId): void {
  emitSync(C.PAGE_LIFECYCLE, s.simulatorWc, { appSessionId: s.appSessionId, bridgeId, event: 'pageShow' })
}

export function pageHide(s: Session, bridgeId = s.rootBridgeId): void {
  emitSync(C.PAGE_LIFECYCLE, s.simulatorWc, { appSessionId: s.appSessionId, bridgeId, event: 'pageHide' })
}

export function pageUnload(s: Session, bridgeId = s.rootBridgeId): void {
  emitSync(C.PAGE_LIFECYCLE, s.simulatorWc, { appSessionId: s.appSessionId, bridgeId, event: 'pageUnload' })
}

export async function openSecondPage(s: Session): Promise<string> {
  const result = (await invokeHandler(C.PAGE_OPEN, s.simulatorWc, {
    appSessionId: s.appSessionId,
    pagePath: SECOND_PAGE,
  })) as { bridgeId: string }
  return result.bridgeId
}

/** Host-level hide via `minimize` (mirrors real macOS/Windows minimize). */
export function minimizeHost(s: Session): void {
  s.mainWindow.setMinimized(true)
  s.mainWindow.fire('minimize')
}

/** Host-level hide via `hide` (mirrors e.g. Cmd+H / closing to tray). */
export function hideHost(s: Session): void {
  s.mainWindow.fire('hide')
}

/** Host-level restore (mirrors real un-minimize). */
export function restoreHost(s: Session): void {
  s.mainWindow.setMinimized(false)
  s.mainWindow.fire('restore')
}

/** Host-level `show` while still minimized — must NOT foreground on its own. */
export function showWhileMinimized(s: Session): void {
  s.mainWindow.fire('show')
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(APP_CONFIG)))))
})

afterEach(async () => {
  for (const registry of openRegistries.splice(0)) await registry.dispose()
  electronStubs.handlers.clear()
  electronStubs.sync.removeAllListeners()
  fakes.reset()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  __resetMiniappSessionConfigForTests()
})
