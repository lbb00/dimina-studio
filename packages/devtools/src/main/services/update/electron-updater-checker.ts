import path from 'node:path'
import { createRequire } from 'node:module'
import { isSameUpdateInfo, type UpdateChecker, type UpdateInfo } from '../../../shared/types.js'

export interface ElectronUpdaterCancellationToken {
  cancel(): void
}

export interface ElectronUpdaterFile {
  url: string | URL
  sha512?: string
}

export interface ElectronUpdaterMetadata {
  version: string
  releaseNotes?: string | Array<{ note: string }>
  files?: ElectronUpdaterFile[]
}

export interface ElectronUpdaterCheckResult {
  isUpdateAvailable: boolean
  updateInfo: ElectronUpdaterMetadata
  cancellationToken?: ElectronUpdaterCancellationToken
}

export interface ElectronUpdaterProgress {
  percent: number
}

/** The updater surface this adapter needs; tests inject it without loading the SDK. */
export interface ElectronUpdaterEngine {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  disableDifferentialDownload: boolean
  checkForUpdates(): Promise<ElectronUpdaterCheckResult | null>
  downloadUpdate(cancellationToken?: ElectronUpdaterCancellationToken): Promise<string[]>
  quitAndInstall(): void
  on(event: 'download-progress' | 'error', listener: (value: ElectronUpdaterProgress | Error) => void): unknown
  removeListener(event: 'download-progress' | 'error', listener: (value: ElectronUpdaterProgress | Error) => void): unknown
}

export interface ElectronUpdaterCheckerOptions {
  updater?: ElectronUpdaterEngine
  platform?: NodeJS.Platform
  arch?: string
}

interface CheckedUpdate {
  info: UpdateInfo
  result: ElectronUpdaterCheckResult
  fileName: string
}

interface DownloadTask {
  update: CheckedUpdate
  token?: ElectronUpdaterCancellationToken
  progressCallbacks: Set<(percent: number) => void>
  promise: Promise<string>
}

/**
 * Adapt electron-updater to the host-facing checker contract.
 *
 * Loading electron-updater is deliberately deferred until this factory is used:
 * hosts which inject their own checker never load its native platform proxy.
 */
export function createElectronUpdaterChecker(options: ElectronUpdaterCheckerOptions = {}): UpdateChecker {
  const updater = options.updater ?? loadElectronUpdater()
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.disableDifferentialDownload = false

  let current: CheckedUpdate | null = null
  let checkTask: Promise<UpdateInfo | null> | null = null
  let downloadTask: DownloadTask | null = null
  let owner = 0
  let disposed = false
  let downloadedPath: string | null = null

  const checker: UpdateChecker = {
    async checkForUpdates(): Promise<UpdateInfo | null> {
      if (disposed) return null
      if (checkTask) return checkTask
      const task = check(updater, platform, arch)
      checkTask = task
      try {
        const info = await task
        if (disposed || !info) return null
        const result = lastResult
        if (!result) return null
        const next = toCheckedUpdate(info, result, platform, arch)
        if (!next) return null
        if (!sameUpdate(current, next)) {
          owner += 1
          downloadTask?.token?.cancel()
          downloadTask = null
          downloadedPath = null
        }
        current = next
        return info
      } finally {
        if (checkTask === task) checkTask = null
        lastResult = null
      }
    },

    async downloadUpdate(info, onProgress): Promise<string> {
      if (disposed) throw new Error('Updater checker disposed')
      if (!current || !sameInfo(current.info, info)) throw new Error('Update is no longer current')
      if (downloadTask && sameUpdate(downloadTask.update, current)) {
        if (onProgress) downloadTask.progressCallbacks.add(onProgress)
        return downloadTask.promise
      }

      const taskOwner = owner
      const update = current
      const token = update.result.cancellationToken
      const progressCallbacks = new Set<(percent: number) => void>()
      if (onProgress) progressCallbacks.add(onProgress)
      const progress = (value: ElectronUpdaterProgress | Error) => {
        if (taskOwner !== owner || disposed || value instanceof Error) return
        for (const callback of progressCallbacks) callback(value.percent)
      }
      // electron-updater can emit `error` after cancellation. Keep this
      // listener until its promise settles so EventEmitter never treats a
      // late updater error as an unhandled process exception.
      const error = () => undefined
      updater.on('download-progress', progress)
      updater.on('error', error)
      const promise = updater.downloadUpdate(token).then((paths) => {
        if (disposed || taskOwner !== owner || !sameUpdate(current, update)) {
          throw new Error('Update changed during download')
        }
        const downloaded = selectDownloadedFile(paths, update.fileName)
        if (!downloaded) throw new Error('Updater did not return a downloaded file')
        downloadedPath = downloaded
        return downloaded
      }).finally(() => {
        updater.removeListener('download-progress', progress)
        updater.removeListener('error', error)
        if (downloadTask?.promise === promise) downloadTask = null
      })
      downloadTask = { update, token, progressCallbacks, promise }
      return promise
    },

    installUpdate(filePath): void {
      if (!disposed && filePath === downloadedPath) updater.quitAndInstall()
    },

    dispose(): void {
      disposed = true
      owner += 1
      downloadTask?.token?.cancel()
      current = null
      downloadedPath = null
    },
  }

  let lastResult: ElectronUpdaterCheckResult | null = null
  async function check(
    engine: ElectronUpdaterEngine,
    targetPlatform: NodeJS.Platform,
    targetArch: string,
  ): Promise<UpdateInfo | null> {
    const result = await engine.checkForUpdates()
    if (!result?.isUpdateAvailable) return null
    const selected = selectMetadataFile(result.updateInfo.files ?? [], targetPlatform, targetArch)
    if (!selected) return null
    lastResult = result
    return {
      version: result.updateInfo.version,
      downloadUrl: String(selected.url),
      releaseNotes: normalizeReleaseNotes(result.updateInfo.releaseNotes),
      ...(selected.sha512 ? { sha512: selected.sha512 } : {}),
    }
  }

  return checker
}

function loadElectronUpdater(): ElectronUpdaterEngine {
  const require = createRequire(import.meta.url)
  return (require('electron-updater') as { autoUpdater: ElectronUpdaterEngine }).autoUpdater
}

function toCheckedUpdate(
  info: UpdateInfo,
  result: ElectronUpdaterCheckResult,
  platform: NodeJS.Platform,
  arch: string,
): CheckedUpdate | null {
  const selected = selectMetadataFile(result.updateInfo.files ?? [], platform, arch)
  if (!selected || String(selected.url) !== info.downloadUrl) return null
  return {
    info,
    result,
    fileName: fileName(selected),
  }
}

function selectMetadataFile(
  files: ElectronUpdaterFile[],
  platform: NodeJS.Platform,
  arch: string,
): ElectronUpdaterFile | undefined {
  const expectedExtension = platform === 'darwin' ? '.zip' : platform === 'win32' ? '.exe' : '.appimage'
  const extensionMatches = files.filter((file) => updatePathname(file.url).toLowerCase().endsWith(expectedExtension))
  const archMatch = extensionMatches.find((file) => matchesArchitecture(fileName(file), arch))
  if (archMatch) return archMatch

  return extensionMatches.find((file) => !hasKnownArchitecture(fileName(file)))
}

function selectDownloadedFile(paths: string[], selectedFileName: string): string | undefined {
  return paths.find((filePath) => path.basename(filePath).toLowerCase() === selectedFileName)
}

function fileName(file: ElectronUpdaterFile): string {
  return decodePathname(path.basename(updatePathname(file.url))).toLowerCase()
}

function updatePathname(value: string | URL): string {
  const raw = String(value)
  try {
    return new URL(raw).pathname
  } catch {
    const delimiter = raw.search(/[?#]/)
    return delimiter === -1 ? raw : raw.slice(0, delimiter)
  }
}

function decodePathname(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function matchesArchitecture(name: string, arch: string): boolean {
  return architectureNames(arch).some((candidate) => name.includes(candidate))
}

function hasKnownArchitecture(name: string): boolean {
  return ['arm64', 'aarch64', 'x64', 'x86_64', 'amd64', 'ia32', 'x86'].some((arch) => name.includes(arch))
}

function architectureNames(arch: string): string[] {
  switch (arch.toLowerCase()) {
    case 'arm64':
      return ['arm64', 'aarch64']
    case 'x64':
      return ['x64', 'x86_64', 'amd64']
    case 'ia32':
      return ['ia32', 'x86']
    default:
      return [arch.toLowerCase()]
  }
}

function normalizeReleaseNotes(notes: ElectronUpdaterMetadata['releaseNotes']): string | undefined {
  if (Array.isArray(notes)) return notes.map((item) => item.note).join('\n')
  return notes
}

function sameInfo(left: UpdateInfo, right: UpdateInfo): boolean {
  return isSameUpdateInfo(left, right)
}

function sameUpdate(left: CheckedUpdate | null, right: CheckedUpdate | null): boolean {
  return Boolean(left && right && sameInfo(left.info, right.info))
}
