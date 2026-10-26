import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { createElectronUpdaterChecker } from './electron-updater-checker.js'

type SourceUpdate = {
  version: string
  files: Array<{ url: string; sha512: string }>
  releaseNotes?: string
}

type CheckResult = {
  isUpdateAvailable: boolean
  updateInfo: SourceUpdate
  cancellationToken?: { cancel: () => void }
}

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  disableDifferentialDownload = true
  readonly checkForUpdates = vi.fn<() => Promise<CheckResult | null>>()
  readonly downloadUpdate = vi.fn<(token?: CheckResult['cancellationToken']) => Promise<string[]>>()
  readonly quitAndInstall = vi.fn()
}

function available(version: string, url: string): CheckResult {
  return availableFiles(version, [{ url, sha512: `${version}-sha512` }])
}

function availableFiles(version: string, files: SourceUpdate['files']): CheckResult {
  return {
    isUpdateAvailable: true,
    updateInfo: { version, files, releaseNotes: `Notes for ${version}` },
    cancellationToken: { cancel: vi.fn<() => void>() },
  }
}

function install(checker: ReturnType<typeof createElectronUpdaterChecker>, filePath: string) {
  const installUpdate = (checker as typeof checker & { installUpdate?: (path: string) => unknown }).installUpdate
  expect(installUpdate).toBeTypeOf('function')
  return installUpdate!(filePath)
}

function dispose(checker: ReturnType<typeof createElectronUpdaterChecker>) {
  const disposeChecker = (checker as typeof checker & { dispose?: () => unknown }).dispose
  expect(disposeChecker).toBeTypeOf('function')
  return disposeChecker!()
}

describe('createElectronUpdaterChecker', () => {
  it('disables automatic side effects and returns null when no update is available', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: false,
      updateInfo: { version: '1.0.0', files: [] },
    })

    const checker = createElectronUpdaterChecker({ updater })

    await expect(checker.checkForUpdates('1.0.0')).resolves.toBeNull()
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.disableDifferentialDownload).toBe(false)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('keeps a relative signed filename intact and matches its decoded local path', async () => {
    const updater = new FakeUpdater()
    const relative = 'Dimina%20DevTools-2.0.0-arm64.zip?signature=token'
    updater.checkForUpdates.mockResolvedValue(available('2.0.0', relative))
    updater.downloadUpdate.mockResolvedValue(['/tmp/Dimina DevTools-2.0.0-arm64.zip'])
    const checker = createElectronUpdaterChecker({ updater, platform: 'darwin', arch: 'arm64' })

    const info = await checker.checkForUpdates('1.0.0')

    expect(info).toMatchObject({ version: '2.0.0', downloadUrl: relative })
    await expect(checker.downloadUpdate(info!)).resolves.toBe('/tmp/Dimina DevTools-2.0.0-arm64.zip')
  })

  it('selects the engine-supported file for each mac architecture, Windows, and Linux', async () => {
    const files = [
      { url: 'Dimina-2.0.0-x64.zip', sha512: 'mac-x64' },
      { url: 'Dimina-2.0.0-arm64.zip', sha512: 'mac-arm64' },
      { url: 'Dimina-2.0.0-x64.exe', sha512: 'win' },
      { url: 'Dimina-2.0.0-x64.AppImage', sha512: 'linux' },
    ]
    const cases: Array<[NodeJS.Platform, string, string]> = [
      ['darwin', 'x64', 'Dimina-2.0.0-x64.zip'],
      ['darwin', 'arm64', 'Dimina-2.0.0-arm64.zip'],
      ['win32', 'x64', 'Dimina-2.0.0-x64.exe'],
      ['linux', 'x64', 'Dimina-2.0.0-x64.AppImage'],
    ]

    for (const [platform, arch, expectedUrl] of cases) {
      const updater = new FakeUpdater()
      updater.checkForUpdates.mockResolvedValue(availableFiles('2.0.0', files))
      const checker = createElectronUpdaterChecker({ updater, platform, arch })
      await expect(checker.checkForUpdates('1.0.0')).resolves.toMatchObject({ downloadUrl: expectedUrl })
    }
  })

  it('shares concurrent checks and concurrent downloads for the same update', async () => {
    const updater = new FakeUpdater()
    const checking = deferred<CheckResult | null>()
    updater.checkForUpdates.mockReturnValue(checking.promise)
    const downloading = deferred<string[]>()
    updater.downloadUpdate.mockReturnValue(downloading.promise)
    const checker = createElectronUpdaterChecker({ updater })

    const firstCheck = checker.checkForUpdates('1.0.0')
    const secondCheck = checker.checkForUpdates('1.0.0')
    checking.resolve(available('2.0.0', 'https://updates.example/2.0.0.zip'))

    const [firstInfo, secondInfo] = await Promise.all([firstCheck, secondCheck])
    expect(firstInfo).toEqual(secondInfo)
    expect(firstInfo).toMatchObject({
      version: '2.0.0',
      downloadUrl: 'https://updates.example/2.0.0.zip',
      releaseNotes: 'Notes for 2.0.0',
    })
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)

    const firstProgress = vi.fn()
    const secondProgress = vi.fn()
    const firstDownload = checker.downloadUpdate(firstInfo!, firstProgress)
    const secondDownload = checker.downloadUpdate(secondInfo!, secondProgress)
    updater.emit('download-progress', { percent: 36.5 })
    downloading.resolve(['/tmp/2.0.0.zip'])

    await expect(Promise.all([firstDownload, secondDownload])).resolves.toEqual(['/tmp/2.0.0.zip', '/tmp/2.0.0.zip'])
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(firstProgress).toHaveBeenCalledWith(36.5)
    expect(secondProgress).toHaveBeenCalledWith(36.5)
  })

  it('cancels a replaced download and prevents stale progress, files, and installation from winning', async () => {
    const updater = new FakeUpdater()
    const first = available('2.0.0', 'https://updates.example/2.0.0.zip')
    const second = available('3.0.0', 'https://updates.example/3.0.0.zip')
    updater.checkForUpdates.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const oldDownload = deferred<string[]>()
    const currentDownload = deferred<string[]>()
    updater.downloadUpdate.mockReturnValueOnce(oldDownload.promise).mockReturnValueOnce(currentDownload.promise)
    const checker = createElectronUpdaterChecker({ updater })

    const oldInfo = await checker.checkForUpdates('1.0.0')
    const oldProgress = vi.fn()
    const oldTask = checker.downloadUpdate(oldInfo!, oldProgress).catch(() => undefined)
    const currentInfo = await checker.checkForUpdates('1.0.0')

    expect(first.cancellationToken!.cancel).toHaveBeenCalledTimes(1)
    updater.emit('download-progress', { percent: 74 })
    oldDownload.resolve(['/tmp/old.zip'])
    await oldTask
    expect(oldProgress).not.toHaveBeenCalled()

    const currentTask = checker.downloadUpdate(currentInfo!)
    currentDownload.resolve(['/tmp/3.0.0.zip'])
    await expect(currentTask).resolves.toBe('/tmp/3.0.0.zip')

    await install(checker, '/tmp/old.zip')
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    await install(checker, '/tmp/3.0.0.zip')
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('treats a checksum change as a replacement even when version and URL are unchanged', async () => {
    const updater = new FakeUpdater()
    const original = availableFiles('2.0.0', [{ url: 'Dimina-2.0.0.zip', sha512: 'old-checksum' }])
    const replacement = availableFiles('2.0.0', [{ url: 'Dimina-2.0.0.zip', sha512: 'new-checksum' }])
    updater.checkForUpdates.mockResolvedValueOnce(original).mockResolvedValueOnce(replacement)
    const downloading = deferred<string[]>()
    updater.downloadUpdate.mockReturnValue(downloading.promise)
    const checker = createElectronUpdaterChecker({ updater })

    const oldInfo = await checker.checkForUpdates('1.0.0')
    expect(oldInfo).toMatchObject({ sha512: 'old-checksum' })
    const oldTask = checker.downloadUpdate(oldInfo!).catch(() => undefined)
    const replacementInfo = await checker.checkForUpdates('1.0.0')

    expect(replacementInfo).toMatchObject({ sha512: 'new-checksum' })
    expect(original.cancellationToken!.cancel).toHaveBeenCalledTimes(1)
    downloading.resolve(['/tmp/Dimina-2.0.0.zip'])
    await oldTask
    await install(checker, '/tmp/Dimina-2.0.0.zip')
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it("does not accept the engine's cancelled old download as the replacement download", async () => {
    const updater = new FakeUpdater()
    const first = available('2.0.0', 'Dimina-2.0.0-x64.zip')
    const second = available('3.0.0', 'Dimina-3.0.0-x64.zip')
    updater.checkForUpdates.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const oldDownload = deferred<string[]>()
    // AppUpdater returns its existing downloadPromise until that task settles,
    // even when a caller supplies a new cancellation token.
    updater.downloadUpdate.mockReturnValue(oldDownload.promise)
    const checker = createElectronUpdaterChecker({ updater })

    const firstInfo = await checker.checkForUpdates('1.0.0')
    const firstTask = checker.downloadUpdate(firstInfo!).catch(() => undefined)
    const secondInfo = await checker.checkForUpdates('1.0.0')
    const secondTask = checker.downloadUpdate(secondInfo!)
    oldDownload.resolve(['/tmp/Dimina-2.0.0.zip'])

    await firstTask
    await expect(secondTask).rejects.toThrow()
    await install(checker, '/tmp/Dimina-2.0.0-x64.zip')
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('removes its listeners and cancels active work synchronously when disposed', async () => {
    const updater = new FakeUpdater()
    const baselineProgressListeners = updater.listenerCount('download-progress')
    const baselineErrorListeners = updater.listenerCount('error')
    const check = available('2.0.0', 'https://updates.example/2.0.0.zip')
    updater.checkForUpdates.mockResolvedValue(check)
    const downloading = deferred<string[]>()
    updater.downloadUpdate.mockReturnValue(downloading.promise)
    const checker = createElectronUpdaterChecker({ updater })
    const info = await checker.checkForUpdates('1.0.0')
    const task = checker.downloadUpdate(info!).catch(() => undefined)

    dispose(checker)

    expect(check.cancellationToken!.cancel).toHaveBeenCalledTimes(1)
    await install(checker, '/tmp/2.0.0.zip')
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    // The engine can still report an error until its in-flight request settles.
    // Keep that listener until settlement, then return every listener to baseline.
    expect(() => updater.emit('error', new Error('late updater error'))).not.toThrow()
    downloading.reject(new Error('late transport failure'))
    await task
    expect(updater.listenerCount('download-progress')).toBe(baselineProgressListeners)
    expect(updater.listenerCount('error')).toBe(baselineErrorListeners)
  })

  it('allows a failed download to retry and installs only the downloaded current file', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates.mockResolvedValue(available('2.0.0', 'https://updates.example/2.0.0.zip'))
    updater.downloadUpdate.mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValueOnce(['/tmp/2.0.0.zip'])
    const checker = createElectronUpdaterChecker({ updater })
    const info = await checker.checkForUpdates('1.0.0')

    await expect(checker.downloadUpdate(info!)).rejects.toThrow('network unavailable')
    await expect(checker.downloadUpdate(info!)).resolves.toBe('/tmp/2.0.0.zip')
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2)

    await install(checker, '/tmp/other.zip')
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    await install(checker, '/tmp/2.0.0.zip')
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})
