import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    ipcHandlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => ipcHandlers.set(channel, handler)),
      removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    app: { getVersion: vi.fn(() => '1.0.0'), quit: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
    shell: { openPath: vi.fn(async () => '') },
  }
})

vi.mock('electron', () => ({
  app: electron.app,
  ipcMain: electron.ipcMain,
  shell: electron.shell,
  BrowserWindow: class {},
  webContents: { getAllWebContents: () => [] },
  nativeImage: { createFromPath: () => ({}) },
}))

import type { UpdateChecker, UpdateInfo } from '../../../shared/types.js'
import { UpdateManager } from './update-manager.js'

function update(sha512: string): UpdateInfo {
  return { version: '2.0.0', downloadUrl: 'Dimina-2.0.0.zip', sha512 }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((onResolve) => { resolve = onResolve })
  return { promise, resolve }
}

beforeEach(() => {
  electron.ipcHandlers.clear()
  electron.shell.openPath.mockClear()
  electron.app.quit.mockClear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('UpdateManager checksum identity', () => {
  it('returns a replacement with prompt state and rejects the late old download', async () => {
    const first = update('old-checksum')
    const replacement = update('new-checksum')
    const oldDownload = deferred<string>()
    const checker: UpdateChecker = {
      checkForUpdates: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(replacement),
      downloadUpdate: vi.fn((info) => info.sha512 === 'old-checksum'
        ? oldDownload.promise
        : Promise.resolve('/tmp/new.zip')),
    }
    const showUpdatePanel = vi.fn()
    const manager = new UpdateManager({
      checker,
      showUpdatePanel,
      notifyDownloadProgress: vi.fn(),
      hideUpdatePanel: vi.fn(),
    })

    await manager.checkAndReveal()
    const stale = manager.download()
    await manager.checkAndReveal()

    expect(showUpdatePanel).toHaveBeenNthCalledWith(1, first)
    expect(showUpdatePanel).toHaveBeenNthCalledWith(2, replacement)
    expect(showUpdatePanel.mock.calls[1][0]).not.toHaveProperty('downloadState')

    const fresh = manager.download()
    expect(checker.downloadUpdate).toHaveBeenNthCalledWith(2, replacement, expect.any(Function))
    oldDownload.resolve('/tmp/old.zip')

    await expect(stale).resolves.toEqual({ success: false, error: 'Update changed during download' })
    await expect(fresh).resolves.toEqual({ success: true, filePath: '/tmp/new.zip' })
    await expect(manager.install()).resolves.toEqual({ success: true })
    expect(electron.shell.openPath).toHaveBeenCalledWith('/tmp/new.zip')
    expect(electron.shell.openPath).not.toHaveBeenCalledWith('/tmp/old.zip')
    await manager.dispose()
  })
})
