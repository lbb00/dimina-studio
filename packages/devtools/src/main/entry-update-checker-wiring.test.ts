/**
 * The standalone entry (`src/main/index.ts`) is the only place that decides
 * whether this packaged app checks for its own updates. Hosts that embed
 * devtools call `launch(config)` and supply their own checker.
 *
 * `UpdateManager` registers its IPC handlers and the periodic check only when
 * a checker is supplied. This entry passes `createElectronUpdaterChecker()`
 * for a packaged release-channel build. Unpackaged `pnpm dev` and packaged
 * dev-channel builds (`-dev.<timestamp>`) stay isolated from stable release
 * metadata.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const state = vi.hoisted(() => ({ isPackaged: false, version: '0.4.0' }))

vi.mock('electron', () => ({
  app: {
    get isPackaged() { return state.isPackaged },
    getVersion: () => state.version,
    exit: vi.fn(),
  },
}))

const launchMock = vi.hoisted(() => vi.fn((_config?: { updateChecker?: unknown }) => Promise.resolve()))
vi.mock('./app/launch.js', () => ({
  launch: launchMock,
  buildDefaultMenu: () => {},
  openSettingsWindow: () => Promise.resolve(),
}))

const createElectronUpdaterCheckerMock = vi.hoisted(() =>
  vi.fn(() => ({ __checker: true })),
)
vi.mock('./services/update/index.js', () => ({
  createElectronUpdaterChecker: createElectronUpdaterCheckerMock,
}))

beforeEach(() => {
  vi.resetModules()
  state.isPackaged = false
  state.version = '0.4.0'
  launchMock.mockClear()
  createElectronUpdaterCheckerMock.mockClear()
})

describe('main entry: standalone update-checker wiring', () => {
  it('packaged release-channel build (no -dev. suffix): launch() receives the electron-updater checker', async () => {
    state.isPackaged = true
    state.version = '0.4.0'

    await import('./index.js')

    expect(createElectronUpdaterCheckerMock).toHaveBeenCalledTimes(1)
    expect(createElectronUpdaterCheckerMock).toHaveBeenCalledWith()

    expect(launchMock).toHaveBeenCalledTimes(1)
    const config = launchMock.mock.calls[0]?.[0]
    // Identity, not just truthiness — passing some other truthy value under
    // `updateChecker` would satisfy toBeDefined() without actually wiring the
    // factory's checker through to launch().
    expect(config?.updateChecker).toBe(createElectronUpdaterCheckerMock.mock.results[0]?.value)
  })

  it('packaged DEV-channel build (-dev.<timestamp> suffix): launch() gets no updateChecker', async () => {
    // Dev-channel versions carry `-dev.<timestamp>`. They must not consult
    // stable release metadata and replace the branch build under test.
    state.isPackaged = true
    state.version = '0.4.1-dev.20260716123738'

    await import('./index.js')

    expect(createElectronUpdaterCheckerMock).not.toHaveBeenCalled()
    expect(launchMock).toHaveBeenCalledTimes(1)
    const config = launchMock.mock.calls[0]?.[0]
    expect(config?.updateChecker).toBeUndefined()
  })

  it('pnpm dev (unpackaged) run: launch() gets no updateChecker — no release metadata, no update dialog', async () => {
    state.isPackaged = false

    await import('./index.js')

    expect(createElectronUpdaterCheckerMock).not.toHaveBeenCalled()
    expect(launchMock).toHaveBeenCalledTimes(1)
    const config = launchMock.mock.calls[0]?.[0]
    expect(config?.updateChecker).toBeUndefined()
  })
})
