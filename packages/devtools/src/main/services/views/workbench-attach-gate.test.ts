/**
 * Workbench attach gate: while the app boot critical window is open (old
 * session teardown + first compile), `holdWorkbenchAttach()` defers the
 * workbench WebContentsView's heavy creation (`new WebContentsView` +
 * `loadURL`) even when the editor slot's desired placement is already
 * visible. The gate only postpones creation — it never hides or destroys an
 * already-existing workbench view.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runInNewContext } from 'node:vm'

type StubWebContents = {
  destroyed: boolean
  id: number
  isDestroyed: () => boolean
  close: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  executeJavaScript: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
}
type StubView = {
  webContents: StubWebContents
  setBounds: ReturnType<typeof vi.fn>
}

const constructed: StubView[] = []
let executeWorkbenchScript: (script: string) => Promise<unknown> = () => Promise.resolve(null)

vi.mock('electron', () => {
  let nextId = 1
  class WebContentsView {
    webContents: StubWebContents
    setBounds = vi.fn()
    constructor(_opts?: unknown) {
      const id = nextId++
      this.webContents = {
        destroyed: false,
        id,
        isDestroyed() { return this.destroyed },
        close: vi.fn(function (this: StubWebContents) { this.destroyed = true }),
        loadURL: vi.fn(() => Promise.resolve()),
        executeJavaScript: vi.fn((script: string) => executeWorkbenchScript(script)),
        setWindowOpenHandler: vi.fn(),
      }
      constructed.push(this as unknown as StubView)
    }
  }
  const ipcMain = { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() }
  return {
    WebContentsView,
    ipcMain,
    shell: { openExternal: vi.fn() },
    nativeTheme: { shouldUseDarkColors: false, on: vi.fn(), removeListener: vi.fn() },
    webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
    default: { ipcMain },
  }
})

vi.mock('../../utils/paths.js', () => ({
  mainPreloadPath: '/stub/preload.js',
  hostToolbarRuntimePreloadPath: '/stub/host-toolbar-preload.js',
  hostSidebarRuntimePreloadPath: '/stub/host-sidebar-preload.js',
  hostDialogRuntimePreloadPath: '/stub/host-dialog-preload.js',
  cjsSiblingPreloadPath: (p: string) => p.replace(/\.js$/, '.cjs'),
  devtoolsPackageRoot: '/stub/devtools-pkg-root',
}))

import { createViewManager } from './view-manager.js'
import { workbenchBounds } from './placement-test-driver.js'
import { createConnectionRegistry } from 'electron-deck/main'
import { createCdpSessionBroker } from '../cdp-session/index.js'

function makeContext() {
  const addChildView = vi.fn()
  const removeChildView = vi.fn()
  const contentView = { addChildView, removeChildView, children: [] }
  const mainWindow = {
    destroyed: false,
    contentView,
    isDestroyed() { return this.destroyed },
    getContentSize: () => [1280, 980],
  }
  return {
    mainWindow,
    ctx: {
      windows: { mainWindow: mainWindow as unknown as import('electron').BrowserWindow } as import('../window-service.js').WindowService,
      rendererDir: '/stub/renderer',
      panels: ['console', 'wxml', 'storage', 'appdata'],
      notify: { popoverInit: vi.fn(), popoverClosed: vi.fn() } as unknown as import('../notifications/renderer-notifier.js').RendererNotifier,
      connections: createConnectionRegistry(),
      cdpSessionBroker: createCdpSessionBroker(),
      preloadPath: '/stub/sim-preload.js',
    },
  }
}

const WORKBENCH_URL = 'http://127.0.0.1:9000/'
const VISIBLE_RECT = { x: 0, y: 0, width: 800, height: 600 }

// The gate has to have created zero views and issued zero loadURL calls yet.
function expectNoAttachYet(): void {
  expect(constructed.length).toBe(0)
}

async function flushWorkbenchTasks(): Promise<void> {
  for (let turn = 0; turn < 6; turn++) await Promise.resolve()
}

beforeEach(() => {
  constructed.length = 0
  executeWorkbenchScript = () => Promise.resolve(null)
  vi.useFakeTimers()
})

describe('workbench attach gate: holdWorkbenchAttach defers the lazy WebContentsView creation', () => {
  it('does not create the workbench view while held, even with a source set and the editor slot visible', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    expect(typeof mgr.holdWorkbenchAttach).toBe('function')
    mgr.holdWorkbenchAttach()
    workbenchBounds(mgr, VISIBLE_RECT)

    expectNoAttachYet()
  })

  it('releasing the hold replays reconcileNow and creates + loads the workbench view', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    const release = mgr.holdWorkbenchAttach()
    workbenchBounds(mgr, VISIBLE_RECT)
    expectNoAttachYet()

    release()

    expect(constructed.length).toBe(1)
    expect(constructed[0]!.webContents.loadURL).toHaveBeenCalledTimes(1)
  })

  it('self-releases 3000ms after the hold with a console.warn fail-loud marker, and does not act twice', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    mgr.holdWorkbenchAttach()
    workbenchBounds(mgr, VISIBLE_RECT)
    expectNoAttachYet()

    vi.advanceTimersByTime(3000)

    expect(constructed.length).toBe(1)
    expect(constructed[0]!.webContents.loadURL).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)

    // No second self-release action: further elapsed time is a no-op.
    vi.advanceTimersByTime(10_000)
    expect(constructed.length).toBe(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)

    warnSpy.mockRestore()
  })

  it('a new hold supersedes the previous one: the old release is a no-op and the cap timer restarts', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    const releaseA = mgr.holdWorkbenchAttach()
    workbenchBounds(mgr, VISIBLE_RECT)

    // Two seconds pass before the second hold supersedes the first.
    vi.advanceTimersByTime(2000)
    const releaseB = mgr.holdWorkbenchAttach()

    // A's release is stale — it must not open the gate.
    releaseA()
    expectNoAttachYet()

    // B's timer restarts from its own hold: 2999ms after B is still held.
    vi.advanceTimersByTime(2999)
    expectNoAttachYet()
    expect(warnSpy).not.toHaveBeenCalled()

    releaseB()
    expect(constructed.length).toBe(1)
    expect(constructed[0]!.webContents.loadURL).toHaveBeenCalledTimes(1)

    warnSpy.mockRestore()
  })

  it('calling the same release twice only replays the gate once (idempotent, no throw)', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    const release = mgr.holdWorkbenchAttach()
    workbenchBounds(mgr, VISIBLE_RECT)

    expect(() => {
      release()
      release()
    }).not.toThrow()

    expect(constructed.length).toBe(1)
    expect(constructed[0]!.webContents.loadURL).toHaveBeenCalledTimes(1)
  })

  it('openFileInWorkbench passes straight through the gate on explicit user intent', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    mgr.holdWorkbenchAttach()
    workbenchBounds(mgr, VISIBLE_RECT)
    expectNoAttachYet()

    const dispatched = mgr.openFileInWorkbench('pages/index.js', 1, 1)

    expect(dispatched).toBe(true)
    expect(constructed.length).toBe(1)
    expect(constructed[0]!.webContents.loadURL).toHaveBeenCalledTimes(1)
  })

  it('detachWorkbench during a hold does not release the gate', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    mgr.holdWorkbenchAttach()
    workbenchBounds(mgr, VISIBLE_RECT)

    mgr.detachWorkbench()
    vi.advanceTimersByTime(2000)

    expectNoAttachYet()
  })

  it('holding after the view already exists has no effect: the live view is untouched and stays usable', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    workbenchBounds(mgr, VISIBLE_RECT)
    expect(constructed.length).toBe(1)
    const liveView = constructed[0]!

    mgr.holdWorkbenchAttach()

    // The already-existing view must not be hidden or destroyed by the hold.
    expect(constructed.length).toBe(1)
    expect(liveView.webContents.destroyed).toBe(false)
    expect(liveView.webContents.close).not.toHaveBeenCalled()

    const dispatched = mgr.openFileInWorkbench('pages/index.js', 1, 1)
    expect(dispatched).toBe(true)
    // No second view constructed by the follow-up user-intent call.
    expect(constructed.length).toBe(1)
  })

  it('detachWorkbench during a hold preserves the desired placement, so release recreates the view (project-switch teardown)', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    // A workbench is already live (the outgoing project's editor).
    mgr.setWorkbenchSource(WORKBENCH_URL)
    workbenchBounds(mgr, VISIBLE_RECT)
    expect(constructed.length).toBe(1)
    const firstView = constructed[0]!

    // The incoming project's openProject holds the gate, then its teardown
    // section destroys the outgoing view — the desired placement must
    // survive this so release() can rebuild it for the new project.
    const release = mgr.holdWorkbenchAttach()
    mgr.detachWorkbench()
    expect(firstView.webContents.close).toHaveBeenCalledTimes(1)

    release()

    // A second WebContentsView is created and loaded — the editor comes
    // back for the new project once the gate opens.
    expect(constructed.length).toBe(2)
    expect(constructed[1]!.webContents.loadURL).toHaveBeenCalledTimes(1)
  })

  it('cancelWorkbenchAttachHold vetoes a hold outright: a close-path teardown after cancel never rebuilds a zombie view', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    workbenchBounds(mgr, VISIBLE_RECT)
    expect(constructed.length).toBe(1)

    const release = mgr.holdWorkbenchAttach()
    expect(typeof mgr.cancelWorkbenchAttachHold).toBe('function')
    mgr.cancelWorkbenchAttachHold()
    // close-path teardown after the cancel (app teardown / closeProject).
    mgr.detachWorkbench()

    // Neither the (now-canceled) hold's late cap timer nor its late release
    // may rebuild the view: the request that owned this hold is gone.
    vi.advanceTimersByTime(3000)
    release()

    expect(constructed.length).toBe(1)
    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('cancelWorkbenchAttachHold with no active hold is a no-op and leaves an existing view untouched', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    workbenchBounds(mgr, VISIBLE_RECT)
    expect(constructed.length).toBe(1)
    const liveView = constructed[0]!

    expect(() => mgr.cancelWorkbenchAttachHold()).not.toThrow()

    expect(constructed.length).toBe(1)
    expect(liveView.webContents.destroyed).toBe(false)
    expect(liveView.webContents.close).not.toHaveBeenCalled()
  })

  it('replays a request made while the editor is hidden after lazy attach reaches ready', async () => {
    const readyWaiters: Array<() => void> = []
    const revealed: string[] = []
    executeWorkbenchScript = (script) => {
      if (script.includes('dimina-workbench-ready')) {
        return new Promise((resolve) => readyWaiters.push(() => resolve(true)))
      }
      if (script.includes('showTextDocument')) revealed.push(script)
      return Promise.resolve(true)
    }
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    expect(mgr.openFileInWorkbench('pages/hidden.js', 3, 4)).toBe(true)
    workbenchBounds(mgr, VISIBLE_RECT)
    await flushWorkbenchTasks()
    expect(readyWaiters).toHaveLength(1)
    expect(revealed).toHaveLength(0)

    readyWaiters[0]!()
    await flushWorkbenchTasks()

    expect(revealed).toHaveLength(1)
    expect(revealed[0]).toContain('file:///workspace/pages/hidden.js')
  })

  it('does not mistake the early probe for boot readiness', async () => {
    const readyWaiters: Array<() => void> = []
    const revealed: string[] = []
    // This fake page exposes the diagnostic probe before its boot-complete
    // signal, just as bootWorkbench does while it still populates the workspace.
    executeWorkbenchScript = (script) => {
      if (script.includes('dimina-workbench-ready')) {
        if (script.includes('window.__WB_PROBE')) return Promise.resolve(true)
        return new Promise((resolve) => readyWaiters.push(() => resolve(true)))
      }
      if (script.includes('showTextDocument')) revealed.push(script)
      return Promise.resolve(true)
    }
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    workbenchBounds(mgr, VISIBLE_RECT)
    await flushWorkbenchTasks()
    mgr.openFileInWorkbench('pages/booting.js', 1, 1)
    await flushWorkbenchTasks()

    expect(revealed).toHaveLength(0)
    expect(readyWaiters).toHaveLength(2)
    for (const ready of readyWaiters) ready()
    await flushWorkbenchTasks()
    expect(revealed).toHaveLength(1)
  })

  it('settles every ready waiter and removes its listeners when boot fails', async () => {
    type Listener = () => void
    const listeners = new Map<string, Set<Listener>>()
    const page = {
      __WB_READY: false,
      __WB_ERROR: undefined as string | undefined,
      addEventListener: (name: string, listener: Listener) => {
        let entries = listeners.get(name)
        if (!entries) listeners.set(name, entries = new Set())
        entries.add(listener)
      },
      removeEventListener: (name: string, listener: Listener) => listeners.get(name)?.delete(listener),
    }
    const emit = (name: string) => {
      for (const listener of [...(listeners.get(name) ?? [])]) listener()
    }
    executeWorkbenchScript = (script) => {
      if (!script.includes('dimina-workbench-ready')) return Promise.resolve(true)
      return runInNewContext(script, { window: page }) as Promise<unknown>
    }
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    workbenchBounds(mgr, VISIBLE_RECT)
    await flushWorkbenchTasks()
    mgr.openFileInWorkbench('pages/failing-boot.js', 1, 1)
    await flushWorkbenchTasks()

    expect([...listeners.values()].reduce((count, entries) => count + entries.size, 0)).toBeGreaterThan(0)
    page.__WB_ERROR = 'boot failed'
    emit('dimina-workbench-failed')
    await flushWorkbenchTasks()

    expect([...listeners.values()].reduce((count, entries) => count + entries.size, 0)).toBe(0)
  })

  it('keeps only the most recent hidden-editor request until ready', async () => {
    const readyWaiters: Array<() => void> = []
    const revealed: string[] = []
    executeWorkbenchScript = (script) => {
      if (script.includes('dimina-workbench-ready')) {
        return new Promise((resolve) => readyWaiters.push(() => resolve(true)))
      }
      if (script.includes('showTextDocument')) revealed.push(script)
      return Promise.resolve(true)
    }
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    mgr.openFileInWorkbench('pages/first.js', 1, 1)
    mgr.openFileInWorkbench('pages/latest.js', 2, 3)
    workbenchBounds(mgr, VISIBLE_RECT)
    await flushWorkbenchTasks()
    readyWaiters[0]!()
    await flushWorkbenchTasks()

    expect(revealed).toHaveLength(1)
    expect(revealed[0]).toContain('file:///workspace/pages/latest.js')
  })

  it('does not let an old asynchronous document open replace a newer request', async () => {
    let pageOpenEpoch = 0
    let resolveOldOpen: (() => void) | undefined
    const shown: string[] = []
    executeWorkbenchScript = (script) => {
      if (script.includes('dimina-workbench-ready')) return Promise.resolve(true)
      if (!script.includes('showTextDocument')) return Promise.resolve(true)
      const epoch = Number(script.match(/const requestEpoch = (\d+)/)?.[1])
      pageOpenEpoch = epoch
      const finish = (path: string, capturedEpoch: number) => {
        if (pageOpenEpoch === capturedEpoch) shown.push(path)
        return pageOpenEpoch === capturedEpoch
      }
      if (script.includes('pages/slow.js')) {
        return new Promise((resolve) => {
          resolveOldOpen = () => resolve(finish('slow', epoch))
        })
      }
      return Promise.resolve(finish('latest', epoch))
    }
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    workbenchBounds(mgr, VISIBLE_RECT)
    await flushWorkbenchTasks()
    mgr.openFileInWorkbench('pages/slow.js', 1, 1)
    await flushWorkbenchTasks()
    expect(resolveOldOpen).toBeDefined()

    mgr.openFileInWorkbench('pages/latest.js', 1, 1)
    await flushWorkbenchTasks()
    resolveOldOpen!()
    await flushWorkbenchTasks()

    expect(shown).toEqual(['latest'])
  })

  it('drops a hidden-editor request when detach preempts its source', async () => {
    const revealed: string[] = []
    executeWorkbenchScript = (script) => {
      if (script.includes('showTextDocument')) revealed.push(script)
      return Promise.resolve(true)
    }
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setWorkbenchSource(WORKBENCH_URL)
    mgr.openFileInWorkbench('pages/old-project.js', 1, 1)
    mgr.detachWorkbench()
    workbenchBounds(mgr, VISIBLE_RECT)
    await flushWorkbenchTasks()

    expect(revealed).toHaveLength(0)
  })
})
