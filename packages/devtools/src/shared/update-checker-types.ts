export interface UpdateInfo {
  /** New version string (e.g. '1.2.0'). */
  version: string
  /** URL identifying the selected update artifact. */
  downloadUrl: string
  /** Checksum identifying the selected artifact when the updater provides one. */
  sha512?: string
  releaseNotes?: string
  mandatory?: boolean
  downloadState?: UpdateDownloadState
}

export function isSameUpdateInfo(left: UpdateInfo | null | undefined, right: UpdateInfo | null | undefined): boolean {
  return Boolean(
    left &&
    right &&
    left.version === right.version &&
    left.downloadUrl === right.downloadUrl &&
    left.sha512 === right.sha512,
  )
}

export interface UpdateDownloadState {
  stage: 'prompt' | 'downloading' | 'ready' | 'error'
  progress: number
  error?: string
}

export interface UpdateChecker {
  checkForUpdates(currentVersion: string): Promise<UpdateInfo | null>
  downloadUpdate(info: UpdateInfo, onProgress?: (percent: number) => void): Promise<string>
  installUpdate?(filePath: string): void | Promise<void>
  dispose?(): void | Promise<void>
}
