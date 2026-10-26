import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCompileLogBuffer } from './compile-log-buffer.js'
import { createSessionStatusStore } from './session-status-store.js'
import { tapNotifierIntoStores } from './status-tap.js'
import { ipcMain } from 'electron'
import { CompileStatusChannel } from '../../../shared/ipc-channels-overlays.js'
import { registerCompileStatusDetailsIpc } from '../../ipc/compile-status-details.js'
import type { RendererNotifier } from '../notifications/renderer-notifier.js'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return ({
  ipcMain: new EventEmitter(),
  app: { getPath: vi.fn(() => '/tmp/dimina-test-userdata'), isPackaged: true },
  nativeTheme: { themeSource: 'system' },
  default: {},
}) })

vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs')
  const readFileSync = vi.fn(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })
  const mocked = { ...real, readFileSync, existsSync: vi.fn(() => false), writeFileSync: vi.fn(), mkdirSync: vi.fn() }
  return { ...mocked, default: mocked }
})

vi.mock('../projects/project-repository.js', () => ({
  validateProjectDir: vi.fn(() => null),
  listProjects: vi.fn(() => []),
  addProject: vi.fn((path: string) => ({ name: 'fake', path })),
  removeProject: vi.fn(),
  updateLastOpened: vi.fn(),
  getProjectPages: vi.fn(() => ({ pages: [], entryPagePath: '' })),
  getCompileConfig: vi.fn(() => ({ startPage: '', scene: 1011, queryParams: [] })),
  saveCompileConfig: vi.fn(),
  getProjectSettings: vi.fn(() => ({ uploadWithSourceMap: false })),
  updateProjectSettings: vi.fn(),
}))

type Diagnostic = {
  source: string
  line: number
  column: number
  endLine: number
  endColumn: number
  message: string
  severity: string
  code?: string
}
type StatusPayload = { status: string; message: string; diagnostics?: Diagnostic[]; previewStale?: boolean }
type WorkbenchContext = import('../workbench-context.js').WorkbenchContext
let createWorkspaceService: typeof import('./workspace-service.js').createWorkspaceService

function provider(): import('../projects/types.js').ProjectsProvider {
  return { listProjects: vi.fn(() => []), addProject: vi.fn(), removeProject: vi.fn() }
}

function session(appId: string) {
  return { port: 12345, appInfo: { appId }, close: vi.fn(async () => {}) }
}

beforeEach(async () => {
  vi.resetModules()
  ;({ createWorkspaceService } = await import('./workspace-service.js'))
})

describe('workspace-service compile diagnostics', () => {
  it('keeps one validated diagnostic and marks a watcher failure as stale while the preview is live', async () => {
    const projectStatus = vi.fn<(payload: StatusPayload) => void>()
    let onBuildError: ((error: unknown) => void) | undefined
    const adapter = {
      openProject: vi.fn(async (options: { onBuildError?: (error: unknown) => void }) => {
        onBuildError = options.onBuildError
        return session('live')
      }),
    }
    const statusStore = createSessionStatusStore()
    const notify = tapNotifierIntoStores(
      { projectStatus } as unknown as RendererNotifier,
      statusStore,
      createCompileLogBuffer(),
    )
    const ctx = {
      adapter,
      notify,
      views: { disposeAll: vi.fn(), holdWorkbenchAttach: vi.fn(() => vi.fn()), detachWorkbench: vi.fn(), detachSimulator: vi.fn() },
      projectsProvider: provider(),
    } as unknown as WorkbenchContext

    await createWorkspaceService(ctx).openProject('/project')
    const diagnostic = {
      source: 'pages/index/index.ts', line: 3, column: 2, endLine: 3, endColumn: 8,
      message: 'unexpected token', severity: 'error', code: 'E_PARSE',
    }
    onBuildError!({ message: 'compile failed', diagnostics: [diagnostic, diagnostic, { line: 0 }] })

    expect(projectStatus).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'error',
      previewStale: true,
      diagnostics: [diagnostic],
    }))
    expect(statusStore.get()).toMatchObject({
      phase: 'error', previewStale: true, diagnostics: [diagnostic],
    })
  })

  it('closes project error details and clears source diagnostics before session teardown completes', async () => {
    let onBuildError!: (error: unknown) => void
    let finishClose!: () => void
    const closing = new Promise<void>(resolve => { finishClose = resolve })
    const statusStore = createSessionStatusStore()
    const unsubscribed = vi.fn()
    const subscribe = statusStore.subscribe.bind(statusStore)
    vi.spyOn(statusStore, 'subscribe').mockImplementation(listener => {
      const remove = subscribe(listener)
      return () => { unsubscribed(); remove() }
    })
    const views = { disposeAll: vi.fn(), holdWorkbenchAttach: vi.fn(() => vi.fn()),
      cancelWorkbenchAttachHold: vi.fn(), detachWorkbench: vi.fn(), detachSimulator: vi.fn(),
      disposeProjectViews: vi.fn(), showCompileStatusDetails: vi.fn(), hideCompileStatusDetails: vi.fn() }
    const ctx = { views, sessionStatus: statusStore, projectsProvider: provider(),
      adapter: { openProject: vi.fn(async (options: { onBuildError?: (error: unknown) => void }) => {
        onBuildError = options.onBuildError!
        return { ...session('live'), close: () => closing }
      }) },
      notify: tapNotifierIntoStores({ projectStatus: vi.fn() } as unknown as RendererNotifier, statusStore, createCompileLogBuffer()),
    }
    const source = { id: 88, mainFrame: { processId: 1, routingId: 88 }, isDestroyed: () => false, getURL: () => 'file:///trusted/index.html' } as unknown as import('electron').WebContents
    const registration = registerCompileStatusDetailsIpc({ resolve: sender => sender === source ? ctx : null, list: () => [ctx] })
    const workspace = createWorkspaceService(ctx as unknown as WorkbenchContext)
    try {
      await workspace.openProject('/project')
      onBuildError({ message: 'old error', diagnostics: [{ source: 'index.js', line: 1, column: 1, endLine: 1, endColumn: 2, message: 'parse', severity: 'error' }] })
      ipcMain.emit(CompileStatusChannel.Show, { sender: source, senderFrame: source.mainFrame })
      expect(views.showCompileStatusDetails).toHaveBeenCalledOnce()
      const closed = workspace.closeProject()
      await vi.waitFor(() => expect(statusStore.get()).toMatchObject({ phase: 'idle', diagnostics: [] }))
      expect(views.hideCompileStatusDetails).toHaveBeenCalledOnce()
      expect(unsubscribed).toHaveBeenCalledOnce()
      finishClose()
      await closed
      onBuildError(new Error('late error'))
      expect(views.showCompileStatusDetails).toHaveBeenCalledOnce()
    } finally { finishClose(); registration.dispose(); vi.restoreAllMocks() }
  })

  it('keeps a closed project idle when its initial compile rejects late', async () => {
    let rejectCompile!: (reason: unknown) => void
    const compile = new Promise<never>((_resolve, reject) => { rejectCompile = reject })
    const statusStore = createSessionStatusStore()
    const projectStatus = vi.fn<(payload: StatusPayload) => void>()
    const adapter = { openProject: vi.fn(() => compile) }
    const ctx = { adapter, projectsProvider: provider(),
      notify: tapNotifierIntoStores({ projectStatus } as unknown as RendererNotifier, statusStore, createCompileLogBuffer()),
      views: { disposeAll: vi.fn(), holdWorkbenchAttach: vi.fn(() => vi.fn()), cancelWorkbenchAttachHold: vi.fn(),
        detachWorkbench: vi.fn(), detachSimulator: vi.fn(), disposeProjectViews: vi.fn() },
    } as unknown as WorkbenchContext
    const workspace = createWorkspaceService(ctx)
    const opening = workspace.openProject('/project')
    await vi.waitFor(() => expect(adapter.openProject).toHaveBeenCalledOnce())
    await workspace.closeProject()
    expect(statusStore.get().phase).toBe('idle')
    rejectCompile(new Error('late initial failure'))
    await opening
    expect(statusStore.get()).toMatchObject({ phase: 'idle', diagnostics: [] })
    expect(projectStatus.mock.calls.filter(([status]) => status.status === 'error')).toEqual([])
  })

  it('drops a superseded session build callback before it can overwrite the current status', async () => {
    const projectStatus = vi.fn<(payload: StatusPayload) => void>()
    const callbacks: Array<(error: unknown) => void> = []
    const adapter = {
      openProject: vi.fn(async (options: { onBuildError?: (error: unknown) => void }) => {
        callbacks.push(options.onBuildError!)
        return session(`app-${callbacks.length}`)
      }),
    }
    const ctx = {
      adapter,
      notify: { projectStatus },
      views: { disposeAll: vi.fn(), holdWorkbenchAttach: vi.fn(() => vi.fn()), detachWorkbench: vi.fn(), detachSimulator: vi.fn() },
      projectsProvider: provider(),
    } as unknown as WorkbenchContext
    const workspace = createWorkspaceService(ctx)

    await workspace.openProject('/first')
    await workspace.openProject('/second')
    const before = projectStatus.mock.calls.length
    callbacks[0]!(new Error('late first-project failure'))

    expect(projectStatus).toHaveBeenCalledTimes(before)
  })
})
