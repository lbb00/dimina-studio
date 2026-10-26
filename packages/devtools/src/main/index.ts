import { app } from 'electron'
import { launch } from './app/launch.js'
import { createElectronUpdaterChecker } from './services/update/index.js'

// Only packaged release-channel builds use the application updater. Development
// channels never consult release metadata, so branch builds stay isolated from
// stable releases.
const updateChecker = app.isPackaged && !app.getVersion().includes('-dev.')
  ? createElectronUpdaterChecker()
  : undefined

// Fire-and-forget boot: launch() returns the electron-deck whenReady gate
// promise. A bare call would let a boot failure escape as an unhandledRejection
// (no diagnostics, can be swallowed). Surface it via a structured failure exit:
// log the cause and exit non-zero (see docs/library-integration.md).
launch({ updateChecker }).catch((err: unknown) => {
  console.error('[devtools] fatal: launch() failed during boot', err)
  app.exit(1)
})
