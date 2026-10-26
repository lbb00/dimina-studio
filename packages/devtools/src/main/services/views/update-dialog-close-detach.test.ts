/**
 * `ViewManager.hideUpdateDialog()` is the main-side half of the update
 * dialog's close path (see `update-manager.ts`'s `UpdateChannel.Close`
 * handler): the renderer only unmounts its own DOM on close, so main must
 * itself detach the update-dialog WebContentsView on `hideUpdateDialog()`, or
 * it stays presented (added to `contentView`) forever — an invisible
 * click-eating overlay sitting above every other view at the `dialog` layer.
 *
 * This pins the ViewManager-level half of that chain: once the panel is
 * actually placed (shown + marked ready, which is what makes the reconciler
 * add it to `contentView`), `hideUpdateDialog()` must detach it —
 * `removeChildView` called with the same WebContentsView instance —
 * without destroying the webContents (a later `show()` reuses it).
 *
 * Harness mirrors view-manager-dispose-scopes.test.ts (electron mock
 * tracking constructed WebContentsViews via `h.constructed`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type StubWebContents = {
  destroyed: boolean
  id: number
  emit: (event: string, ...args: unknown[]) => void
  isDestroyed: () => boolean
  focus: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  setZoomFactor: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  executeJavaScript: ReturnType<typeof vi.fn>
}
type StubView = {
  webContents: StubWebContents
  setBounds: ReturnType<typeof vi.fn>
  setBackgroundColor: ReturnType<typeof vi.fn>
  setVisible: ReturnType<typeof vi.fn>
}

const h = vi.hoisted(() => ({
  constructed: [] as StubView[],
  mockFromId: vi.fn((_id: number) => null as unknown),
  registerPreloadScript: vi.fn(() => 'stub-preload-script-id'),
  unregisterPreloadScript: vi.fn(),
}))

vi.mock('electron', () => {
  let nextId = 1
  class WebContentsView {
    webContents: StubWebContents
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
    setVisible = vi.fn()
    constructor(_opts?: unknown) {
      const id = nextId++
      const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
      this.webContents = {
        destroyed: false,
        id,
        emit(event: string, ...args: unknown[]) {
          for (const handler of [...(handlers.get(event) ?? [])]) handler(...args)
        },
        isDestroyed() { return this.destroyed },
        focus: vi.fn(),
        close: vi.fn(function (this: StubWebContents) { this.destroyed = true }),
        loadFile: vi.fn(() => Promise.resolve()),
        loadURL: vi.fn(() => Promise.resolve()),
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          handlers.set(event, [...(handlers.get(event) ?? []), handler])
        }),
        once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          const onceHandler = (...args: unknown[]) => {
            handlers.set(
              event,
              (handlers.get(event) ?? []).filter((item) => item !== onceHandler),
            )
            handler(...args)
          }
          handlers.set(event, [...(handlers.get(event) ?? []), onceHandler])
        }),
        setWindowOpenHandler: vi.fn(),
        setZoomFactor: vi.fn(),
        send: vi.fn(),
        executeJavaScript: vi.fn(() => Promise.resolve(undefined)),
      }
      h.constructed.push(this as unknown as StubView)
    }
  }
  const ipcMain = {
    on: vi.fn(),
    removeListener: vi.fn(),
    handle: vi.fn(),
    removeHandler: vi.fn(),
  }
  return {
    WebContentsView,
    ipcMain,
    shell: { openExternal: vi.fn() },
    nativeTheme: { shouldUseDarkColors: false, on: vi.fn(), removeListener: vi.fn() },
    webContents: {
      fromId: (id: number) => h.mockFromId(id),
      getAllWebContents: vi.fn(() => []),
    },
    session: {
      defaultSession: {
        registerPreloadScript: h.registerPreloadScript,
        unregisterPreloadScript: h.unregisterPreloadScript,
      },
    },
    default: { ipcMain },
  }
})

vi.mock('../../utils/paths.js', () => ({
  mainPreloadPath: '/stub/preload.js',
  hostToolbarRuntimePreloadPath: '/stub/host-toolbar-runtime-preload.cjs',
  hostSidebarRuntimePreloadPath: '/stub/host-sidebar-runtime-preload.cjs',
  hostDialogRuntimePreloadPath: '/stub/host-dialog-runtime-preload.cjs',
  cjsSiblingPreloadPath: (p: string) => p.replace(/\.js$/, '.cjs'),
  devtoolsPackageRoot: '/stub/devtools-pkg-root',
}))

import { createConnectionRegistry } from 'electron-deck/main'
import type { ViewManager } from './view-manager.js'

async function loadCreateViewManager() {
  const mod = await import('./view-manager.js')
  return mod.createViewManager
}

function makeContext() {
  const size: [number, number] = [1280, 980]
  const addChildView = vi.fn()
  const removeChildView = vi.fn()
  const contentView = { addChildView, removeChildView, children: [] }
  const mainWindow = {
    destroyed: false,
    contentView,
    isDestroyed() { return this.destroyed },
    getContentSize: () => size,
  }
  const notify = {
    popoverInit: vi.fn(),
    popoverClosed: vi.fn(),
    hostToolbarHeightChanged: vi.fn(),
    updateAvailable: vi.fn(),
    projectCreateInit: vi.fn(),
    devicePickerInit: vi.fn(),
  }
  return {
    mainWindow,
    size,
    addChildView,
    removeChildView,
    contentView,
    notify,
    ctx: {
      windows: {
        mainWindow: mainWindow as unknown as import('electron').BrowserWindow,
      } as import('../window-service.js').WindowService,
      rendererDir: '/stub/renderer',
      notify: notify as unknown as import('../notifications/renderer-notifier.js').RendererNotifier,
      connections: createConnectionRegistry(),
      preloadPath: '/stub/sim-preload.js',
    },
  }
}

beforeEach(() => {
  vi.resetModules()
  h.constructed.length = 0
  h.registerPreloadScript.mockClear()
  h.unregisterPreloadScript.mockClear()
  h.mockFromId.mockReset()
})

describe('ViewManager.hideUpdateDialog: detaches a placed panel without destroying it', () => {
  it('removeChildView is called with the placed view once shown+ready, not before', async () => {
    const createViewManager = await loadCreateViewManager()
    const { addChildView, removeChildView, ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.showUpdateDialog({ version: '1.2.0', downloadUrl: 'https://example.com/update.zip' })
    const view = h.constructed[h.constructed.length - 1]!
    const webContentsId = mgr.getUpdateDialogWebContentsId()
    expect(webContentsId).toBe(view.webContents.id)

    // `readyMode: 'manual'` gates placement on markReady — before that fires,
    // hide()/setDesired never ran addChildView yet.
    expect(removeChildView).not.toHaveBeenCalled()

    mgr.markOverlayReady(webContentsId!)
    expect(addChildView).toHaveBeenCalledWith(view)

    mgr.hideUpdateDialog()

    expect(removeChildView).toHaveBeenCalledWith(view)
    // Hidden, not destroyed — a later show() must reuse this same instance.
    expect(view.webContents.close).not.toHaveBeenCalled()
    expect(view.webContents.destroyed).toBe(false)
    expect(mgr.getUpdateDialogWebContentsId()).toBe(view.webContents.id)
  })

})

const resizablePanels = [
  { name: 'popover', show: (mgr: ViewManager) => mgr.showPopover({}), hide: (mgr: ViewManager) => mgr.hidePopover(), bounds: { x: 0, y: 40, width: 640, height: 408 } },
  { name: 'project create', show: (mgr: ViewManager) => mgr.showProjectCreateDialog({ templates: [], defaultBaseDir: '/tmp' }), hide: (mgr: ViewManager) => mgr.hideProjectCreateDialog(), bounds: { x: 0, y: 0, width: 640, height: 448 } },
  { name: 'update', show: (mgr: ViewManager) => mgr.showUpdateDialog({ version: '1.2.0', downloadUrl: 'https://example.com/update.zip' }), hide: (mgr: ViewManager) => mgr.hideUpdateDialog(), bounds: { x: 0, y: 0, width: 640, height: 448 } },
  { name: 'device picker', show: (mgr: ViewManager) => mgr.showDevicePicker({ deviceName: 'iPhone 16' }), hide: (mgr: ViewManager) => mgr.hideDevicePicker(), bounds: { x: 0, y: 0, width: 640, height: 448 } },
  { name: 'compile status details', show: (mgr: ViewManager) => mgr.showCompileStatusDetails({ phase: 'error', message: 'template failed', watcherAlive: true, updatedAt: 1, generation: 1, diagnostics: [] }), hide: (mgr: ViewManager) => mgr.hideCompileStatusDetails(), bounds: { x: 0, y: 0, width: 640, height: 448 } },
]

describe('overlays resized before readiness', () => {
  it.each(resizablePanels)('$name uses the current window size once ready', async (panel) => {
    const createViewManager = await loadCreateViewManager()
    const { ctx, size, addChildView } = makeContext()
    const mgr = createViewManager(ctx)
    panel.show(mgr)
    const view = h.constructed.at(-1)!
    expect(addChildView).not.toHaveBeenCalled()
    size[0] = 640
    size[1] = 448
    mgr.repositionAll()
    expect(addChildView).not.toHaveBeenCalled()
    mgr.markOverlayReady(view.webContents.id)
    expect(view.setBounds).toHaveBeenLastCalledWith(panel.bounds)
    expect(addChildView).toHaveBeenCalledWith(view)
  })

  it.each(resizablePanels)('$name stays hidden after resize and late readiness, then opens normally', async (panel) => {
    const createViewManager = await loadCreateViewManager()
    const { ctx, size, addChildView } = makeContext()
    const mgr = createViewManager(ctx)
    panel.show(mgr)
    const previous = h.constructed.at(-1)!
    panel.hide(mgr)
    size[0] = 640
    size[1] = 448
    mgr.repositionAll()
    mgr.markOverlayReady(previous.webContents.id)
    expect(addChildView).not.toHaveBeenCalled()
    panel.show(mgr)
    const current = h.constructed.at(-1)!
    mgr.markOverlayReady(current.webContents.id)
    expect(current.setBounds).toHaveBeenLastCalledWith(panel.bounds)
    expect(addChildView).toHaveBeenCalledWith(current)
  })
})


it('does not focus a compile error panel hidden before its late ready signal', async () => {
  const createViewManager = await loadCreateViewManager()
  const { ctx } = makeContext()
  const mgr = createViewManager(ctx)
  mgr.showCompileStatusDetails({ phase: 'error', message: 'old', watcherAlive: true, updatedAt: 1, generation: 1, diagnostics: [] })
  const view = h.constructed.at(-1)!
  mgr.hideCompileStatusDetails()
  mgr.markOverlayReady(view.webContents.id)
  await Promise.resolve()
  await Promise.resolve()
  expect(view.webContents.focus).not.toHaveBeenCalled()
  mgr.disposeAll()
})
