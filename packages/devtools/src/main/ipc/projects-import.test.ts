import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const stubs = vi.hoisted(() => {
  const handlers = new Map<string, Handler>()
  const showMessageBox = vi.fn(async () => ({ response: 0 }))
  return { handlers, showMessageBox }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: stubs.showMessageBox },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => stubs.handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => stubs.handlers.delete(channel)),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  default: {},
}))

import { ProjectsChannel } from '../../shared/ipc-channels.js'
let registerProjectsIpc: typeof import('./projects.js').registerProjectsIpc

const event = { sender: { id: 1, isDestroyed: () => false, getURL: () => '' } }
const project = { name: '项目', path: '/tmp/project', lastOpened: null, type: 'miniprogram' as const }

function context(options: {
  validation?: string | null
  add?: () => Promise<typeof project>
  duplicate?: boolean
  notifyThrows?: boolean
  senderPolicy?: (sender: unknown) => boolean
} = {}) {
  const addProject = vi.fn(options.add ?? (async () => project))
  const category = vi.fn(() => { if (options.notifyThrows) throw new Error('sidebar unavailable') })
  return {
    ctx: {
      workspace: {
        validateProjectDir: vi.fn(async () => options.validation ?? null),
        hasProject: vi.fn(async () => options.duplicate ?? false),
        addProject,
        listProjects: vi.fn(async () => []),
        removeProject: vi.fn(),
      },
      windows: { mainWindow: { id: 1 } },
      senderPolicy: options.senderPolicy,
      projectTemplates: [],
      notify: { hostSidebarCategorySelected: category },
      views: { hostSidebar: { send: vi.fn() } },
    } as never,
    addProject,
    category,
  }
}

async function invoke(...args: unknown[]) {
  const handler = stubs.handlers.get(ProjectsChannel.Import)
  if (!handler) throw new Error('projects:import handler missing')
  return handler(event, ...args)
}

beforeEach(async () => {
  stubs.handlers.clear()
  stubs.showMessageBox.mockClear()
  vi.resetModules()
  ;({ registerProjectsIpc } = await import('./projects.js'))
})

describe('projects:import', () => {
  it.each([{ args: [] }, { args: ['relative/path'] }, { args: [''] }])('returns an actionable path error for malformed arguments %#', async ({ args }) => {
    registerProjectsIpc(context().ctx)
    await expect(invoke(...args)).resolves.toEqual({ ok: false, reason: '请输入完整的绝对项目目录路径。' })
    expect(stubs.showMessageBox).not.toHaveBeenCalled()
  })

  it('returns the validation reason without a native dialog', async () => {
    const setup = context({ validation: '缺少 app.json' })
    registerProjectsIpc(setup.ctx)

    await expect(invoke('/tmp/broken')).resolves.toEqual({ ok: false, reason: '缺少 app.json' })
    expect(setup.addProject).not.toHaveBeenCalled()
    expect(stubs.showMessageBox).not.toHaveBeenCalled()
  })

  it('logs a provider failure and returns a retryable generic reason', async () => {
    const error = new Error('provider secret detail')
    const setup = context({ add: async () => { throw error } })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerProjectsIpc(setup.ctx)

    await expect(invoke('/tmp/project')).resolves.toEqual({ ok: false, reason: '导入失败，请检查项目目录后重试。' })
    expect(log).toHaveBeenCalledWith('[projects] import failed', error)
    expect(stubs.showMessageBox).not.toHaveBeenCalled()
  })

  it('returns a project and notifies the category for a new directory', async () => {
    const setup = context()
    registerProjectsIpc(setup.ctx)

    await expect(invoke('/tmp/project')).resolves.toEqual({ ok: true, project })
    expect(setup.category).toHaveBeenCalledWith('miniprogram')
    expect(stubs.showMessageBox).not.toHaveBeenCalled()
  })

  it('returns a project and notifies the category for an already registered directory', async () => {
    const setup = context({ duplicate: true })
    registerProjectsIpc(setup.ctx)

    await expect(invoke('/tmp/project')).resolves.toEqual({ ok: true, project })
    expect(setup.category).toHaveBeenCalledWith('miniprogram')
    expect(stubs.showMessageBox).not.toHaveBeenCalled()
  })

  it('keeps a committed import successful when sidebar notification fails', async () => {
    const setup = context({ notifyThrows: true })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerProjectsIpc(setup.ctx)

    await expect(invoke('/tmp/project')).resolves.toEqual({ ok: true, project })
    expect(setup.addProject).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('[projects] import notification failed', expect.any(Error))
  })

  it('keeps the channel behind the sender-policy gate', async () => {
    const setup = context({ senderPolicy: () => false })
    registerProjectsIpc(setup.ctx)

    await expect(invoke('/tmp/project')).rejects.toThrow('IPC sender rejected')
    expect(setup.addProject).not.toHaveBeenCalled()
  })
})
