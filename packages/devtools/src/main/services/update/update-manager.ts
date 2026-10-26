import { app, shell } from 'electron'
import { isSameUpdateInfo, type UpdateChecker, type UpdateDownloadState, type UpdateInfo } from '../../../shared/types.js'
import { UpdateChannel } from '../../../shared/ipc-channels-overlays.js'
import { IpcRegistry, type SenderPolicy } from '../../utils/ipc-registry.js'

export interface UpdateManagerOptions {
  checker: UpdateChecker
  /** Show the update-available overlay panel, fed the discovered update's info. */
  showUpdatePanel: (info: UpdateInfo) => void
  /** Forward a download-progress tick into the (already-shown) update overlay. */
  notifyDownloadProgress: (percent: number) => void
  /** Hide the update overlay panel — the renderer's close (any path) forwards here. */
  hideUpdatePanel: () => void
  /** Check interval in milliseconds. Default: 1 hour */
  checkInterval?: number
  /** Delay before the first check after startup in ms. Default: 5000 */
  initialDelay?: number
  /** Override the version string passed to the checker. Default: app.getVersion() */
  getCurrentVersion?: () => string
  /**
   * Optional sender gate. When provided, IpcRegistry rejects invocations
   * whose `event.sender` is not whitelisted (same C-stage policy used by
   * every other workbench-built-in). Omitted in unit tests that mock
   * electron without a real WebContents.
   */
  senderPolicy?: SenderPolicy
}

export class UpdateManager {
  private checker: UpdateChecker
  private showUpdatePanel: (info: UpdateInfo) => void
  private notifyDownloadProgress: (percent: number) => void
  private hideUpdatePanel: () => void
  private getCurrentVersion: () => string
  private latestUpdate: UpdateInfo | null = null
  private downloadedPath: string | null = null
  private downloadState: UpdateDownloadState = { stage: 'prompt', progress: 0 }
  private downloadTask: Promise<{ success: boolean; filePath?: string; error?: string }> | null = null
  private checkTask: Promise<{ hasUpdate: boolean; info?: UpdateInfo }> | null = null
  private updateGeneration = 0
  private checkGeneration = 0
  private revealedCheckGeneration = 0
  /**
   * Whether this instance has already emitted `Available` once. The periodic
   * check fires forever (interval default 1h), and host UI (a host application shell
   * renders a native toast / Notification) is not idempotent — every event
   * stacks. We dedupe at the source: at most one Available per instance
   * lifetime, regardless of how the upstream `info.version` shifts. The user
   * already knows "an update exists"; tracking minor version bumps mid-
   * session is not worth duplicating the toast.
   */
  private hasNotified = false
  private timer: ReturnType<typeof setInterval> | null = null
  private initialTimer: ReturnType<typeof setTimeout> | null = null
  private ipc: IpcRegistry
  /**
   * Set by `dispose()`. Clearing the timers only stops FUTURE ticks — an
   * in-flight `checkAndNotify()` invocation (already past its `await
   * this.check()`) has no timer left to cancel it, and would otherwise call
   * `showUpdatePanel` after dispose has torn down the overlay panel that
   * owns (e.g. `views.disposeAll()` destroying its WebContentsView).
   */
  private disposed = false
  private disposeTask: Promise<void> | null = null

  constructor(opts: UpdateManagerOptions) {
    this.checker = opts.checker
    this.showUpdatePanel = opts.showUpdatePanel
    this.notifyDownloadProgress = opts.notifyDownloadProgress
    this.hideUpdatePanel = opts.hideUpdatePanel
    this.getCurrentVersion = opts.getCurrentVersion ?? (() => app.getVersion())
    this.ipc = new IpcRegistry(opts.senderPolicy)
    this.registerIpc()
    this.startPeriodicCheck(opts.checkInterval ?? 60 * 60 * 1000, opts.initialDelay ?? 5000)
  }

  private registerIpc(): void {
    this.ipc
      .handle(UpdateChannel.Check, async () => this.checkAndReveal())
      .handle(UpdateChannel.Download, async () => this.download())
      .handle(UpdateChannel.Install, async () => this.install())
      .on(UpdateChannel.Close, () => this.hideUpdatePanel())
  }

  async check(): Promise<{ hasUpdate: boolean; info?: UpdateInfo }> {
    if (this.disposed) return { hasUpdate: false }
    if (this.checkTask) return this.checkTask
    const task = this.checkCurrentUpdate()
    this.checkTask = task
    void task.finally(() => {
      if (this.checkTask === task) this.checkTask = null
    })
    return task
  }

  private async checkCurrentUpdate(): Promise<{ hasUpdate: boolean; info?: UpdateInfo }> {
    const requestGeneration = ++this.checkGeneration
    try {
      const currentVersion = this.getCurrentVersion()
      const info = await this.checker.checkForUpdates(currentVersion)
      if (this.disposed || requestGeneration !== this.checkGeneration) return { hasUpdate: false }
      if (info) {
        // The periodic timer re-runs check() forever (see startPeriodicCheck),
        // including after the user already downloaded this same update but
        // before they clicked Install. Only invalidate downloadedPath when the
        // update identity actually changed — unconditionally nulling it here
        // would silently no-op a later install() (it's a bare `if (this.downloadedPath)`)
        // for anyone who takes longer than one check interval to act. Compare
        // downloadUrl too, not just version: a re-uploaded/replaced asset can
        // keep the same version string under a different URL, and reusing the
        // stale downloadedPath would then install bytes that were never
        // actually verified against this checkForUpdates() result.
        const isSameUpdate = isSameUpdateInfo(this.latestUpdate, info)
        this.latestUpdate = info
        if (!isSameUpdate) {
          this.updateGeneration += 1
          this.downloadedPath = null
          this.downloadTask = null
          this.downloadState = { stage: 'prompt', progress: 0 }
        }
        return { hasUpdate: true, info: this.withDownloadState(info) }
      }
      return { hasUpdate: false }
    } catch (err) {
      console.warn('[UpdateManager] check failed:', err)
      return { hasUpdate: false }
    }
  }

  async download(): Promise<{ success: boolean; filePath?: string; error?: string }> {
    if (this.disposed) return { success: false, error: 'Update manager disposed' }
    if (!this.latestUpdate) {
      return { success: false, error: 'No update available' }
    }
    if (this.downloadTask) return this.downloadTask

    const update = this.latestUpdate
    const generation = this.updateGeneration
    this.downloadState = { stage: 'downloading', progress: 0 }
    const task = this.downloadCurrentUpdate(update, generation)
    this.downloadTask = task
    void task.finally(() => {
      if (this.downloadTask === task) this.downloadTask = null
    })
    return task
  }

  private async downloadCurrentUpdate(
    update: UpdateInfo,
    generation: number,
  ): Promise<{ success: boolean; filePath?: string; error?: string }> {
    try {
      const filePath = await this.checker.downloadUpdate(update, (percent) => {
        if (!this.isCurrentUpdate(update, generation)) return
        this.downloadState = { stage: 'downloading', progress: Math.round(percent) }
        this.notifyDownloadProgress(percent)
      })
      if (this.disposed) return { success: false, error: 'Update manager disposed' }
      if (!this.isCurrentUpdate(update, generation)) {
        return { success: false, error: 'Update changed during download' }
      }
      this.downloadedPath = filePath
      this.downloadState = { stage: 'ready', progress: 100 }
      return { success: true, filePath }
    } catch (err) {
      if (this.disposed) return { success: false, error: 'Update manager disposed' }
      if (!this.isCurrentUpdate(update, generation)) {
        return { success: false, error: 'Update changed during download' }
      }
      const error = String(err)
      this.downloadState = { stage: 'error', progress: 0, error }
      console.warn('[UpdateManager] download failed:', err)
      return { success: false, error }
    }
  }

  async install(): Promise<{ success: boolean; error?: string }> {
    if (this.disposed) return { success: false, error: 'Update manager disposed' }
    if (!this.downloadedPath) {
      return { success: false, error: 'No update downloaded' }
    }
    const downloadedPath = this.downloadedPath
    const generation = this.updateGeneration
    if (this.checker.installUpdate) {
      await this.checker.installUpdate(downloadedPath)
      if (this.disposed || generation !== this.updateGeneration) {
        return { success: false, error: 'Update manager disposed' }
      }
      return { success: true }
    }
    // Shell-based installation remains the host checker compatibility path.
    const failure = await shell.openPath(downloadedPath)
    if (this.disposed) return { success: false, error: 'Update manager disposed' }
    if (failure) {
      console.warn('[UpdateManager] install failed:', failure)
      return { success: false, error: failure }
    }
    app.quit()
    return { success: true }
  }

  /**
   * Tear down timers + IPC handlers. Returns a Promise so callers that need
   * a settled cleanup (e.g. workbench registry shutdown, the unit-test
   * lifecycle suite) can await it; calling without await is also safe since
   * the timer clears + handler removals are scheduled synchronously.
   */
  dispose(): Promise<void> {
    if (this.disposeTask) return this.disposeTask
    this.disposed = true
    this.updateGeneration += 1
    this.latestUpdate = null
    this.downloadedPath = null
    this.downloadTask = null
    this.checkTask = null
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.initialTimer) {
      clearTimeout(this.initialTimer)
      this.initialTimer = null
    }
    this.disposeTask = (async () => {
      await this.checker.dispose?.()
      await this.ipc.dispose()
    })()
    return this.disposeTask
  }

  private startPeriodicCheck(interval: number, initialDelay: number): void {
    this.initialTimer = setTimeout(() => void this.checkAndNotify(), initialDelay)
    this.timer = setInterval(() => void this.checkAndNotify(), interval)
  }

  private async checkAndNotify(): Promise<void> {
    const pending = this.check()
    const generation = this.checkGeneration
    const result = await pending
    // dispose() only cancels the timers that SCHEDULE future ticks — a tick
    // already in flight (past this await) has nothing left to cancel it, and
    // must not call into a torn-down panel/registry after the fact.
    if (this.disposed || generation !== this.checkGeneration) return
    if (!result.hasUpdate || !result.info) return
    if (this.hasNotified) return
    this.hasNotified = true
    this.revealedCheckGeneration = generation
    this.showUpdatePanel(result.info)
  }

  async checkAndReveal(): Promise<{ hasUpdate: boolean; info?: UpdateInfo }> {
    const pending = this.check()
    const generation = this.checkGeneration
    const result = await pending
    if (this.disposed || !result.hasUpdate || !result.info || generation !== this.checkGeneration) return result
    if (this.revealedCheckGeneration === generation) return result
    this.hasNotified = true
    this.revealedCheckGeneration = generation
    this.showUpdatePanel(result.info)
    return result
  }

  private isCurrentUpdate(update: UpdateInfo, generation: number): boolean {
    return !this.disposed &&
      generation === this.updateGeneration &&
      isSameUpdateInfo(this.latestUpdate, update)
  }

  private withDownloadState(info: UpdateInfo): UpdateInfo {
    if (this.downloadState.stage === 'prompt') return info
    return { ...info, downloadState: this.downloadState }
  }
}
