/**
 * `loadWorkbenchSettings()` caching contract: the settings file is read and
 * parsed at most once per process, not once per call. `saveWorkbenchSettings()`
 * must invalidate that cache so a load right after a save sees the write
 * instead of replaying stale in-memory data.
 *
 * Pattern lifted from `settings-migration.test.ts`: hoist mock state so
 * `vi.mock('electron', …)` / `vi.mock('fs', …)` can see it, then lazily
 * import the module under test after the mocks are installed. Unlike that
 * file, most tests here call `loadWorkbenchSettings()` more than once
 * against the SAME module instance (no `vi.resetModules()` between calls)
 * because the cache lives in module scope.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => {
  const app = {
    getPath: vi.fn(() => '/tmp/dimina-test-userdata'),
    isPackaged: true,
  }
  const nativeTheme = { themeSource: 'system' }
  return { app, nativeTheme, default: {} }
})

const { readFileSyncMock, writeFileSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
}))

vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs')
  const mocked = {
    ...real,
    readFileSync: readFileSyncMock,
    writeFileSync: writeFileSyncMock,
  }
  return { ...mocked, default: mocked }
})

async function freshModule() {
  vi.resetModules()
  readFileSyncMock.mockReset()
  writeFileSyncMock.mockReset()
  readFileSyncMock.mockReturnValue(JSON.stringify({ theme: 'dark' }))
  return import('./index.js')
}

describe('loadWorkbenchSettings: in-process cache', () => {
  it('reads the settings file at most once across repeated calls', async () => {
    const { loadWorkbenchSettings } = await freshModule()

    loadWorkbenchSettings()
    loadWorkbenchSettings()
    loadWorkbenchSettings()

    expect(readFileSyncMock).toHaveBeenCalledTimes(1)
  })

  it('returns equal settings on later calls instead of re-parsing', async () => {
    const { loadWorkbenchSettings } = await freshModule()

    const first = loadWorkbenchSettings()
    const second = loadWorkbenchSettings()

    expect(second).toEqual(first)
    expect(second.theme).toBe('dark')
  })

  it('hands out an independent clone each call, so mutating one does not corrupt the cache', async () => {
    const { loadWorkbenchSettings } = await freshModule()

    const first = loadWorkbenchSettings()
    first.theme = 'light'
    first.cdp.enabled = true

    const second = loadWorkbenchSettings()
    expect(second.theme).toBe('dark')
    expect(second.cdp.enabled).toBe(false)
    expect(readFileSyncMock).toHaveBeenCalledTimes(1)
  })

  it('re-reads from disk after saveWorkbenchSettings invalidates the cache', async () => {
    const { loadWorkbenchSettings, saveWorkbenchSettings } = await freshModule()

    const before = loadWorkbenchSettings()
    expect(before.theme).toBe('dark')
    expect(readFileSyncMock).toHaveBeenCalledTimes(1)

    readFileSyncMock.mockReturnValue(JSON.stringify({ theme: 'light' }))
    saveWorkbenchSettings({ ...before, theme: 'light' })

    const after = loadWorkbenchSettings()
    expect(after.theme).toBe('light')
    expect(after).not.toBe(before)
    expect(readFileSyncMock).toHaveBeenCalledTimes(2)
  })
})
