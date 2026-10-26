import { launch } from '../dist/main/api.js'

let attempt = 0
let failFirstDownload = () => {}
let allowUpdateCheck = () => {}
const updateCheckReady = new Promise((resolve) => { allowUpdateCheck = resolve })

globalThis.__e2eUpdateControl = {
  failFirstDownload: () => failFirstDownload(),
  allowUpdateCheck: () => allowUpdateCheck(),
}

launch({
  updateChecker: {
    async checkForUpdates() {
      await updateCheckReady
      return { version: '2.0.0', downloadUrl: 'https://example.test/package.dmg' }
    },
    async downloadUpdate(_info, onProgress) {
      onProgress?.(37)
      if (attempt++ > 0) return '/tmp/update-local-flow.dmg'
      await new Promise((_, reject) => { failFirstDownload = () => reject(new Error('temporary download failure')) })
      return '/tmp/unreachable.dmg'
    },
  },
  updateOptions: { initialDelay: 100 },
}).catch((error) => { console.error('[update-local-flow-entry] failed:', error) })
