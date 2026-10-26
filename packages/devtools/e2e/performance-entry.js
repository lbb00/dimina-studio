import electron from 'electron'
import { launch } from '../dist/main/api.js'

if (process.env.NODE_ENV === 'test') {
  electron.app.on('browser-window-created', (_event, window) => {
    window.once('ready-to-show', () => {
      try { window.setPosition(-2000, -2000); window.blur() } catch {}
    })
  })
}

launch({
  onSetup(instance) {
    globalThis.__e2ePerformanceInstance = instance
  },
}).catch((error) => { console.error('[performance-entry] failed:', error) })
