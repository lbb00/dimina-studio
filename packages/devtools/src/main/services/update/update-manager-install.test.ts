/**
 * Regression coverage for two adversarial-review findings on the
 * download → install path:
 *
 * 1. install() must not blindly quit the app after firing
 *    shell.openPath() — that call resolves (never rejects) with an error
 *    message on failure, not an exception. Firing it without awaiting and
 *    quitting immediately after silently closed the app on a failed
 *    install with no way for the renderer to know anything went wrong.
 * 2. check() must only discard a completed download when the update
 *    identity actually changed. Comparing only `version` let a
 *    re-uploaded/replaced asset (same version, different downloadUrl)
 *    keep serving install() the previous, unrelated download.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stub = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown
  const ipcHandlers = new Map<string, Handler>()
  const ipcMainStub = {
    handle: vi.fn((channel: string, fn: Handler) => {
      ipcHandlers.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel)
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  }
  const appStub = {
    getVersion: vi.fn(() => '1.0.0'),
    quit: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  }
  const shellStub = { openPath: vi.fn(async () => '') }
  return { ipcHandlers, ipcMainStub, appStub, shellStub }
})

vi.mock('electron', () => ({
  app: stub.appStub,
  ipcMain: stub.ipcMainStub,
  shell: stub.shellStub,
  BrowserWindow: class {},
  webContents: { getAllWebContents: () => [] },
  nativeImage: { createFromPath: () => ({}) },
}))

import type { UpdateChecker, UpdateInfo } from '../../../shared/types.js'
import { UpdateManager } from './update-manager.js'

function makePanelDeps() {
  return { showUpdatePanel: vi.fn(), notifyDownloadProgress: vi.fn(), hideUpdatePanel: vi.fn() }
}

function makeChecker(sequence: Array<UpdateInfo | null>, downloadPath = '/tmp/fake-update.dmg'): UpdateChecker {
  let i = 0
  return {
    checkForUpdates: vi.fn(async () => {
      const r = sequence[Math.min(i, sequence.length - 1)]
      i++
      return r
    }),
    downloadUpdate: vi.fn(async () => downloadPath),
  }
}

beforeEach(() => {
  stub.ipcHandlers.clear()
  stub.appStub.quit.mockClear()
  stub.shellStub.openPath.mockReset().mockResolvedValue('')
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('UpdateManager.install()', () => {
  it('returns success:false without touching shell when nothing was downloaded', async () => {
    const m = new UpdateManager({ checker: makeChecker([null]), ...makePanelDeps() })

    const result = await m.install()

    expect(result).toEqual({ success: false, error: 'No update downloaded' })
    expect(stub.shellStub.openPath).not.toHaveBeenCalled()
    expect(stub.appStub.quit).not.toHaveBeenCalled()
    await m.dispose()
  })

  it('quits the app only after shell.openPath resolves success (empty string)', async () => {
    const info: UpdateInfo = { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0.dmg' }
    const checker = makeChecker([info])
    const m = new UpdateManager({ checker, ...makePanelDeps() })
    await m.check()
    await m.download()
    stub.shellStub.openPath.mockResolvedValueOnce('')

    const result = await m.install()

    expect(stub.shellStub.openPath).toHaveBeenCalledWith('/tmp/fake-update.dmg')
    expect(stub.appStub.quit).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ success: true })
    await m.dispose()
  })

  it('does NOT quit and surfaces the failure when shell.openPath resolves an error message', async () => {
    const info: UpdateInfo = { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0.dmg' }
    const checker = makeChecker([info])
    const m = new UpdateManager({ checker, ...makePanelDeps() })
    await m.check()
    await m.download()
    stub.shellStub.openPath.mockResolvedValueOnce('no application associated with this file')

    const result = await m.install()

    expect(stub.appStub.quit).not.toHaveBeenCalled()
    expect(result).toEqual({ success: false, error: 'no application associated with this file' })
    await m.dispose()
  })
})

describe('UpdateManager: downloadedPath survives a same-identity re-check, clears on a real change', () => {
  it('a periodic re-check reporting the identical update (same version + downloadUrl) preserves the completed download', async () => {
    const info: UpdateInfo = { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0.dmg' }
    const checker = makeChecker([info, info]) // two checks, same identity
    const m = new UpdateManager({ checker, ...makePanelDeps() })

    await m.check()
    await m.download()
    await m.check() // simulates the periodic timer firing again before Install was clicked

    const result = await m.install()

    expect(stub.shellStub.openPath).toHaveBeenCalledWith('/tmp/fake-update.dmg')
    expect(result).toEqual({ success: true })
    await m.dispose()
  })

  it('a re-check with the same version but a different downloadUrl discards the stale download', async () => {
    const first: UpdateInfo = { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0-a.dmg' }
    const replaced: UpdateInfo = { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0-b.dmg' }
    const checker = makeChecker([first, replaced])
    const m = new UpdateManager({ checker, ...makePanelDeps() })

    await m.check()
    await m.download()
    await m.check() // same version string, but the asset was replaced under a new URL

    const result = await m.install()

    expect(result).toEqual({ success: false, error: 'No update downloaded' })
    expect(stub.shellStub.openPath).not.toHaveBeenCalled()
    await m.dispose()
  })
})

describe('UpdateManager download task lifecycle', () => {
  it('shares concurrent update checks', async () => {
    const info: UpdateInfo = { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0.dmg' }
    let resolveCheck: (result: UpdateInfo | null) => void = () => {}
    const pendingCheck = new Promise<UpdateInfo | null>((resolve) => { resolveCheck = resolve })
    const checker: UpdateChecker = {
      checkForUpdates: vi.fn(() => pendingCheck),
      downloadUpdate: vi.fn(async () => '/tmp/fake-update.dmg'),
    }
    const m = new UpdateManager({ checker, ...makePanelDeps() })

    const first = m.check()
    const second = m.check()

    expect(checker.checkForUpdates).toHaveBeenCalledTimes(1)
    resolveCheck(info)
    await expect(Promise.all([first, second])).resolves.toEqual([
      { hasUpdate: true, info },
      { hasUpdate: true, info },
    ])
    await m.dispose()
  })

  it('shares concurrent download requests for the same update', async () => {
    const info: UpdateInfo = { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0.dmg' }
    let resolveDownload: (path: string) => void = () => {}
    const download = new Promise<string>((resolve) => { resolveDownload = resolve })
    const checker: UpdateChecker = {
      checkForUpdates: vi.fn(async () => info),
      downloadUpdate: vi.fn(() => download),
    }
    const m = new UpdateManager({ checker, ...makePanelDeps() })
    await m.check()

    const first = m.download()
    const second = m.download()

    expect(checker.downloadUpdate).toHaveBeenCalledTimes(1)
    resolveDownload('/tmp/shared-update.dmg')
    await expect(Promise.all([first, second])).resolves.toEqual([
      { success: true, filePath: '/tmp/shared-update.dmg' },
      { success: true, filePath: '/tmp/shared-update.dmg' },
    ])
    await m.dispose()
  })

  it('does not install an older download after a check replaces its update identity', async () => {
    const first: UpdateInfo = { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0-a.dmg' }
    const replacement: UpdateInfo = { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0-b.dmg' }
    let resolveDownload: (path: string) => void = () => {}
    const download = new Promise<string>((resolve) => { resolveDownload = resolve })
    const checker = makeChecker([first, replacement])
    checker.downloadUpdate = vi.fn(() => download)
    const deps = makePanelDeps()
    const m = new UpdateManager({ checker, ...deps })
    await m.check()

    const staleDownload = m.download()
    await m.check()
    resolveDownload('/tmp/stale-update.dmg')

    await expect(staleDownload).resolves.toEqual({ success: false, error: 'Update changed during download' })
    await expect(m.install()).resolves.toEqual({ success: false, error: 'No update downloaded' })
    expect(stub.shellStub.openPath).not.toHaveBeenCalled()
    await m.dispose()
  })

  it('drops a late download completion after dispose without notifying the panel', async () => {
    const info: UpdateInfo = { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0.dmg' }
    let resolveDownload: (path: string) => void = () => {}
    let onProgress: ((percent: number) => void) | undefined
    const download = new Promise<string>((resolve) => { resolveDownload = resolve })
    const checker: UpdateChecker = {
      checkForUpdates: vi.fn(async () => info),
      downloadUpdate: vi.fn((_info, progress) => {
        onProgress = progress
        return download
      }),
    }
    const deps = makePanelDeps()
    const m = new UpdateManager({ checker, ...deps })
    await m.check()

    const pending = m.download()
    await m.dispose()
    onProgress?.(50)
    resolveDownload('/tmp/disposed-update.dmg')

    await expect(pending).resolves.toEqual({ success: false, error: 'Update manager disposed' })
    expect(deps.notifyDownloadProgress).not.toHaveBeenCalled()
    await expect(m.install()).resolves.toEqual({ success: false, error: 'Update manager disposed' })
  })

  it('does not quit when disposal wins while shell is opening the downloaded installer', async () => {
    const info: UpdateInfo = { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0.dmg' }
    let resolveOpenPath: (result: string) => void = () => {}
    const openPath = new Promise<string>((resolve) => { resolveOpenPath = resolve })
    stub.shellStub.openPath.mockReturnValueOnce(openPath)
    const m = new UpdateManager({ checker: makeChecker([info]), ...makePanelDeps() })
    await m.check()
    await m.download()

    const installing = m.install()
    await m.dispose()
    resolveOpenPath('')

    await expect(installing).resolves.toEqual({ success: false, error: 'Update manager disposed' })
    expect(stub.appStub.quit).not.toHaveBeenCalled()
  })

  it('allows a retry after a failed shared download task settles', async () => {
    const info: UpdateInfo = { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0.dmg' }
    const checker: UpdateChecker = {
      checkForUpdates: vi.fn(async () => info),
      downloadUpdate: vi.fn()
        .mockRejectedValueOnce(new Error('network interrupted'))
        .mockResolvedValueOnce('/tmp/retried-update.dmg'),
    }
    const m = new UpdateManager({ checker, ...makePanelDeps() })
    await m.check()

    await expect(m.download()).resolves.toMatchObject({ success: false })
    await expect(m.download()).resolves.toEqual({ success: true, filePath: '/tmp/retried-update.dmg' })
    expect(checker.downloadUpdate).toHaveBeenCalledTimes(2)
    await m.dispose()
  })
})

describe('UpdateManager checker-owned installation and disposal', () => {
  it('delegates only the verified downloaded path to a checker-owned installer', async () => {
    const info: UpdateInfo = { version: '2.0.0', downloadUrl: 'https://example.com/2.0.0.zip' }
    const installUpdate = vi.fn()
    const checker: UpdateChecker = {
      checkForUpdates: vi.fn(async () => info),
      downloadUpdate: vi.fn(async () => '/tmp/verified.zip'),
      installUpdate,
    }
    const manager = new UpdateManager({ checker, ...makePanelDeps() })
    await manager.check()
    await manager.download()

    await expect(manager.install()).resolves.toEqual({ success: true })
    expect(installUpdate).toHaveBeenCalledWith('/tmp/verified.zip')
    expect(stub.shellStub.openPath).not.toHaveBeenCalled()
    expect(stub.appStub.quit).not.toHaveBeenCalled()
    await manager.dispose()
  })

  it('disposes a checker once while retaining the legacy checker compatibility path', async () => {
    const dispose = vi.fn()
    const checker = makeChecker([null])
    checker.dispose = dispose
    const manager = new UpdateManager({ checker, ...makePanelDeps() })

    await Promise.all([manager.dispose(), manager.dispose()])

    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
