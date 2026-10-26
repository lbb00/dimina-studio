import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCompileLogBuffer } from './compile-log-buffer.js'
import { createSessionStatusStore } from './session-status-store.js'
import { tapNotifierIntoStores } from './status-tap.js'
import type { RendererNotifier } from '../notifications/renderer-notifier.js'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { ipcMain: new EventEmitter(), app: { getPath: vi.fn(() => '/tmp/dimina-test-userdata'), isPackaged: true }, nativeTheme: { themeSource: 'system' }, default: {} }
})

vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs')
  const mocked = { ...real, readFileSync: vi.fn(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }), existsSync: vi.fn(() => false), writeFileSync: vi.fn(), mkdirSync: vi.fn() }
  return { ...mocked, default: mocked }
})

vi.mock('../projects/project-repository.js', () => ({
  validateProjectDir: vi.fn(() => null), listProjects: vi.fn(() => []), addProject: vi.fn(), removeProject: vi.fn(), updateLastOpened: vi.fn(),
  getProjectPages: vi.fn(() => ({ pages: [], entryPagePath: '' })), getCompileConfig: vi.fn(() => ({ startPage: '', scene: 1011, queryParams: [] })),
  saveCompileConfig: vi.fn(), getProjectSettings: vi.fn(() => ({ uploadWithSourceMap: false })), updateProjectSettings: vi.fn(),
}))

type Warning = { source: string; line: number; column: number; endLine: number; endColumn: number; message: string; severity: 'warning' }
type Rebuild = (info?: { changedPaths: string[]; styleOnly: boolean; diagnostics?: Warning[] }) => void
type WorkbenchContext = import('../workbench-context.js').WorkbenchContext
type CompileModes = import('../../../shared/types.js').CompileModes
let createWorkspaceService: typeof import('./workspace-service.js').createWorkspaceService

function warning(): Warning {
  return { source: 'pages/index/index.wxml', line: 3, column: 7, endLine: 3, endColumn: 14, message: 'undeclared component', severity: 'warning' }
}

function provider(): import('../projects/types.js').ProjectsProvider {
  return { listProjects: vi.fn(() => []), addProject: vi.fn(), removeProject: vi.fn() }
}

function liveSession(appId: string, diagnostics?: Warning[]) {
  return { port: 12345, appInfo: { appId }, diagnostics, close: vi.fn(async () => {}) }
}

function context(adapter: unknown, status = createSessionStatusStore(), projectsProvider = provider()) {
  const projectStatus = vi.fn()
  return {
    status,
    projectStatus,
    ctx: {
      adapter,
      projectsProvider,
      sessionStatus: status,
      notify: tapNotifierIntoStores({ projectStatus } as unknown as RendererNotifier, status, createCompileLogBuffer()),
      views: { disposeAll: vi.fn(), holdWorkbenchAttach: vi.fn(() => vi.fn()), cancelWorkbenchAttachHold: vi.fn(), detachWorkbench: vi.fn(), detachSimulator: vi.fn(), disposeProjectViews: vi.fn() },
    } as unknown as WorkbenchContext,
  }
}

beforeEach(async () => {
  vi.resetModules()
  ;({ createWorkspaceService } = await import('./workspace-service.js'))
})

describe('workspace warning rebuild lifecycle', () => {
  it('drops an old session rebuild warning after a newer project owns status', async () => {
    const callbacks: Rebuild[] = []
    const adapter = { openProject: vi.fn(async (options: { onRebuild?: Rebuild }) => {
      callbacks.push(options.onRebuild!)
      return liveSession(`app-${callbacks.length}`)
    }) }
    const { ctx, status, projectStatus } = context(adapter)
    const workspace = createWorkspaceService(ctx)

    await workspace.openProject('/first')
    await workspace.openProject('/second')
    const before = status.get()
    const notifications = projectStatus.mock.calls.length
    callbacks[0]!({ changedPaths: ['pages/index/index.wxml'], styleOnly: false, diagnostics: [warning()] })

    expect(status.get()).toBe(before)
    expect(status.get().diagnostics).toEqual([])
    expect(projectStatus).toHaveBeenCalledTimes(notifications)
  })

  it('drops a closed session rebuild warning without reviving idle diagnostics', async () => {
    let rebuild!: Rebuild
    const adapter = { openProject: vi.fn(async (options: { onRebuild?: Rebuild }) => {
      rebuild = options.onRebuild!
      return liveSession('app')
    }) }
    const { ctx, status, projectStatus } = context(adapter)
    const workspace = createWorkspaceService(ctx)

    await workspace.openProject('/project')
    await workspace.closeProject()
    const notifications = projectStatus.mock.calls.length
    rebuild({ changedPaths: ['pages/index/index.wxml'], styleOnly: false, diagnostics: [warning()] })

    expect(status.get()).toMatchObject({ phase: 'idle', diagnostics: [] })
    expect(projectStatus).toHaveBeenCalledTimes(notifications)
  })

  it('publishes a current session rebuild warning as the ready diagnostics snapshot', async () => {
    let rebuild!: Rebuild
    const adapter = { openProject: vi.fn(async (options: { onRebuild?: Rebuild }) => {
      rebuild = options.onRebuild!
      return liveSession('app')
    }) }
    const { ctx, status } = context(adapter)
    const workspace = createWorkspaceService(ctx)

    await workspace.openProject('/project')
    rebuild({ changedPaths: ['pages/index/index.wxml'], styleOnly: false, diagnostics: [warning()] })

    expect(status.get()).toMatchObject({ phase: 'ready', diagnostics: [warning()] })
  })

  it('保留尚在打开中的项目已发布警告，直到被拒绝的后续打开返回', async () => {
    let rejectNext = false
    let rebuild!: Rebuild
    let finishFirst!: (session: ReturnType<typeof liveSession>) => void
    const firstCompile = new Promise<ReturnType<typeof liveSession>>((resolve) => { finishFirst = resolve })
    const adapter = { openProject: vi.fn((options: { projectPath: string; onRebuild?: Rebuild }) => {
      rebuild = options.onRebuild!
      return firstCompile
    }) }
    const { ctx, status, projectStatus } = context(adapter)
    ;(ctx as unknown as { onBeforeOpenProject: (path: string) => Promise<void> }).onBeforeOpenProject = async () => {
      if (rejectNext) throw new Error('permission denied')
    }
    const workspace = createWorkspaceService(ctx)

    const first = workspace.openProject('/first')
    await vi.waitFor(() => expect(adapter.openProject).toHaveBeenCalledOnce())
    rebuild({ changedPaths: ['pages/index/index.wxml'], styleOnly: false, diagnostics: [warning()] })
    expect(status.get()).toMatchObject({ phase: 'ready', diagnostics: [warning()] })

    rejectNext = true
    await expect(workspace.openProject('/second')).resolves.toMatchObject({ success: false, error: 'permission denied' })
    expect(projectStatus).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'error', message: 'permission denied', diagnostics: [warning()],
    }))
    expect(status.get()).toMatchObject({ phase: 'error', diagnostics: [warning()] })

    finishFirst(liveSession('first'))
    await first
    expect(status.get()).toMatchObject({
      phase: 'error', message: 'permission denied', diagnostics: [warning()],
    })
    expect(workspace.getSession()?.appInfo.appId).toBe('first')
  })

  it('publishes a deduplicated clone-safe initial warning snapshot', async () => {
    const original = warning()
    const adapter = { openProject: vi.fn(async () => liveSession('app', [original, original])) }
    const { ctx, status, projectStatus } = context(adapter)

    await createWorkspaceService(ctx).openProject('/project')
    original.message = 'mutated after publication'

    expect(projectStatus).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'ready', diagnostics: [expect.objectContaining({ source: 'pages/index/index.wxml', message: 'undeclared component' })],
    }))
    expect(status.get().diagnostics).toEqual([expect.objectContaining({ source: 'pages/index/index.wxml', message: 'undeclared component' })])
    expect(status.get().diagnostics).toHaveLength(1)
  })

  it('does not let the initial warning overwrite a rebuild that cleared diagnostics during open', async () => {
    let rebuild!: Rebuild
    let releaseModes!: (value: CompileModes) => void
    const modes = new Promise<CompileModes>(resolve => { releaseModes = resolve })
    const projectsProvider = { ...provider(), getCompileModes: vi.fn(() => modes) }
    const adapter = { openProject: vi.fn(async (options: { onRebuild?: Rebuild }) => {
      rebuild = options.onRebuild!
      return liveSession('app', [warning()])
    }) }
    const { ctx, status } = context(adapter, undefined, projectsProvider)
    const opening = createWorkspaceService(ctx).openProject('/project')
    await vi.waitFor(() => expect(projectsProvider.getCompileModes).toHaveBeenCalledOnce())
    rebuild({ changedPaths: ['pages/index/index.wxml'], styleOnly: false, diagnostics: [] })
    releaseModes({ current: -1, list: [] })
    await opening

    expect(status.get()).toMatchObject({ phase: 'ready', diagnostics: [] })
  })

  it('does not let the initial empty result overwrite a rebuild warning during open', async () => {
    let rebuild!: Rebuild
    let releaseModes!: (value: CompileModes) => void
    const modes = new Promise<CompileModes>(resolve => { releaseModes = resolve })
    const projectsProvider = { ...provider(), getCompileModes: vi.fn(() => modes) }
    const adapter = { openProject: vi.fn(async (options: { onRebuild?: Rebuild }) => {
      rebuild = options.onRebuild!
      return liveSession('app', [])
    }) }
    const { ctx, status } = context(adapter, undefined, projectsProvider)
    const opening = createWorkspaceService(ctx).openProject('/project')
    await vi.waitFor(() => expect(projectsProvider.getCompileModes).toHaveBeenCalledOnce())
    rebuild({ changedPaths: ['pages/index/index.wxml'], styleOnly: false, diagnostics: [warning()] })
    releaseModes({ current: -1, list: [] })
    await opening

    expect(status.get()).toMatchObject({ phase: 'ready', diagnostics: [warning()] })
  })

  it('does not let the initial ready result overwrite a rebuild error during open', async () => {
    let buildError!: (error: unknown) => void
    let releaseModes!: (value: CompileModes) => void
    const modes = new Promise<CompileModes>(resolve => { releaseModes = resolve })
    const projectsProvider = { ...provider(), getCompileModes: vi.fn(() => modes) }
    const adapter = { openProject: vi.fn(async (options: { onBuildError?: (error: unknown) => void }) => {
      buildError = options.onBuildError!
      return liveSession('app', [])
    }) }
    const { ctx, status } = context(adapter, undefined, projectsProvider)
    const opening = createWorkspaceService(ctx).openProject('/project')
    await vi.waitFor(() => expect(projectsProvider.getCompileModes).toHaveBeenCalledOnce())
    buildError({ message: 'rebuild failed', diagnostics: [{ ...warning(), severity: 'error' }] })
    releaseModes({ current: -1, list: [] })
    await opening

    expect(status.get()).toMatchObject({ phase: 'error', message: 'rebuild failed', diagnostics: [expect.objectContaining({ severity: 'error' })] })
  })

  it('keeps an initial app-id fallback error instead of replacing it with ready', async () => {
    const reason = '[devkit] could not resolve an appId because the manifest is missing'
    const adapter = { openProject: vi.fn(async (options: { onBuildError?: (error: unknown) => void }) => {
      options.onBuildError!(new Error(reason))
      return liveSession('unknown', [])
    }) }
    const { ctx, status, projectStatus } = context(adapter)

    await expect(createWorkspaceService(ctx).openProject('/project')).resolves.toMatchObject({ success: true, appInfo: { appId: 'unknown' } })

    expect(status.get()).toMatchObject({ phase: 'error', message: reason, diagnostics: [] })
    expect(projectStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error', message: reason, diagnostics: [] }))
  })
})
