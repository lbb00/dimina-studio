import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const stubs = vi.hoisted(() => {
  const handlers = new Map<string, Handler>()
  const showMessageBox = vi.fn(async () => ({ response: 0 }))
  const openProjectWindow = vi.fn()
  return { handlers, showMessageBox, openProjectWindow }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showMessageBox: stubs.showMessageBox,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => stubs.handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => stubs.handlers.delete(channel)),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}))

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api')>()),
  getBranding: vi.fn(async () => undefined),
  onProjectsChanged: vi.fn(() => () => {}),
  onWindowNavigateBack: vi.fn(() => () => {}),
  onWindowOpenProject: vi.fn(() => () => {}),
  onProjectCreateSubmitted: vi.fn(() => () => {}),
  openProjectWindow: stubs.openProjectWindow,
  getHostSidebarWidth: vi.fn(async () => 0),
  onHostSidebarWidthChanged: vi.fn(() => () => {}),
  onHostSidebarCategorySelected: vi.fn(() => () => {}),
  publishPlacementSnapshot: vi.fn(async () => {}),
}))
vi.mock('view-anchor/react', () => ({ useViewAnchor: () => () => {} }))

import Main from './main'
import { registerProjectsIpc } from '../../../main/ipc/projects'

const invalidPath = '/tmp/not-a-miniapp'

const importedProject = { name: '已导入项目', path: '/tmp/valid-miniapp', lastOpened: null, type: 'miniprogram' as const }

function registerProjectHandlers(options: {
  validation?: string | null
  listProjects?: () => Promise<typeof importedProject[]>
  addProject?: () => Promise<typeof importedProject>
  notify?: () => void
} = {}) {
  return {
    addProject: vi.fn(options.addProject ?? (async () => importedProject)),
    notify: vi.fn(options.notify ?? (() => {})),
    listProjects: vi.fn(options.listProjects ?? (async () => [])),
  }
}

let activeHandlers: ReturnType<typeof registerProjectHandlers>
let activeValidation: ReturnType<typeof vi.fn>
let projectRegistration: ReturnType<typeof registerProjectsIpc>

function installBridge() {
  Object.defineProperty(window, 'devtools', {
    configurable: true,
    value: {
      ipc: {
        invoke: async (channel: string, ...args: unknown[]) => {
          const handler = stubs.handlers.get(channel)
          if (!handler) throw new Error(`No handler registered for ${channel}`)
          try {
            return await handler({ sender: { id: 1, isDestroyed: () => false, getURL: () => '' } }, ...args)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`Error invoking remote method '${channel}': ${message}`, { cause: error })
          }
        },
        on: vi.fn(() => () => {}),
        removeListener: vi.fn(),
        send: vi.fn(),
        sendSync: vi.fn(),
      },
    },
  })
}

afterEach(async () => {
  cleanup()
  await projectRegistration.dispose()
})

beforeEach(() => {
  stubs.handlers.clear()
  stubs.showMessageBox.mockClear()
  stubs.openProjectWindow.mockClear()
  installBridge()
  activeHandlers = registerProjectHandlers()
  activeValidation = vi.fn(async () => '缺少 project.config.json')
  projectRegistration = registerProjectsIpc({
    workspace: {
      listProjects: activeHandlers.listProjects,
      validateProjectDir: activeValidation,
      hasProject: vi.fn(async () => false),
      addProject: activeHandlers.addProject,
      removeProject: vi.fn(),
    },
    windows: { mainWindow: { id: 1 } },
    projectTemplates: [],
    notify: { hostSidebarCategorySelected: activeHandlers.notify },
    views: { hostSidebar: { send: vi.fn() } },
  } as never)
})

function configureSuccessfulImportWithNotificationFailure() {
  activeValidation.mockResolvedValue(null)
  activeHandlers.listProjects.mockResolvedValue([importedProject])
  activeHandlers.notify.mockImplementation(() => { throw new Error('sidebar unavailable') })
  return activeHandlers
}

describe('Main import through production projects IPC', () => {
  it('keeps an invalid path inline without a native dialog or Electron wrapper text', async () => {
    render(<Main />)
    fireEvent.click(await screen.findByText('导入'))
    fireEvent.change(await screen.findByLabelText('项目目录'), { target: { value: invalidPath } })
    fireEvent.click(screen.getByRole('button', { name: '导入' }))

    const error = await screen.findByRole('alert')
    expect(error).toHaveTextContent('缺少 project.config.json')
    expect(error).not.toHaveTextContent('Error invoking remote method')
    expect(stubs.showMessageBox).not.toHaveBeenCalled()
    expect(screen.getByLabelText('项目目录')).toHaveValue(invalidPath)
    expect(stubs.openProjectWindow).not.toHaveBeenCalled()
  })

  it('opens once after a committed import even when the post-commit sidebar notification throws', async () => {
    const handlers = configureSuccessfulImportWithNotificationFailure()
    render(<Main />)
    fireEvent.click(await screen.findByText('导入'))
    const directoryInput = await screen.findByLabelText('项目目录')
    fireEvent.change(directoryInput, { target: { value: importedProject.path } })
    expect(directoryInput).toHaveValue(importedProject.path)
    fireEvent.click(screen.getByRole('button', { name: '导入' }))

    await waitFor(() => expect(handlers.addProject).toHaveBeenCalledOnce())
    await waitFor(() => expect(stubs.openProjectWindow).toHaveBeenCalledTimes(1))
    expect(stubs.openProjectWindow).toHaveBeenCalledWith(importedProject)
    expect(handlers.notify).toHaveBeenCalledOnce()
    expect(stubs.showMessageBox).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
