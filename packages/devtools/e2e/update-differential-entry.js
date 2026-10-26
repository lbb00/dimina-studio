import { EventEmitter } from 'node:events'
import { launch, createElectronUpdaterChecker } from '../dist/main/api.js'

let allowUpdateCheck = () => {}
let failFirstDownload = () => {}
const checkReady = new Promise((resolve) => { allowUpdateCheck = resolve })
const extension = process.platform === 'darwin' ? 'zip' : process.platform === 'win32' ? 'exe' : 'AppImage'
const artifact = `update-fixture-2.0.0-${process.platform}-${process.arch}.${extension}`

class LocalUpdater extends EventEmitter {
  checks = 0
  downloads = 0
  installs = 0

  async checkForUpdates() {
    this.checks += 1
    await checkReady
    return {
      isUpdateAvailable: true,
      updateInfo: { version: '2.0.0', files: [{ url: artifact }] },
      cancellationToken: { cancel: () => failFirstDownload() },
    }
  }

  async downloadUpdate() {
    this.emit('download-progress', { percent: 37 })
    if (this.downloads++ > 0) return [`/tmp/${artifact}`]
    await new Promise((_, reject) => {
      failFirstDownload = () => reject(new Error('temporary download failure'))
    })
    throw new Error('First download must fail')
  }

  quitAndInstall() {
    this.installs += 1
  }
}

const updater = new LocalUpdater()
globalThis.__e2eUpdateControl = {
  allowUpdateCheck: () => allowUpdateCheck(),
  failFirstDownload: () => failFirstDownload(),
  snapshot: () => ({
    checks: updater.checks,
    downloads: updater.downloads,
    installs: updater.installs,
    autoDownload: updater.autoDownload,
    autoInstallOnAppQuit: updater.autoInstallOnAppQuit,
    disableDifferentialDownload: updater.disableDifferentialDownload,
  }),
}

launch({
  updateChecker: createElectronUpdaterChecker({ updater }),
  updateOptions: { initialDelay: 100 },
}).catch((error) => { console.error('[update-differential-entry] failed:', error) })
