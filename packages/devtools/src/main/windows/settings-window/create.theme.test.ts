import { describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => {
  const webContents = {
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  }
  const window = {
    webContents,
    once: vi.fn(),
    loadFile: vi.fn(() => Promise.resolve()),
  }
  return { webContents, window }
})

vi.mock('electron', async () => {
  const { createTestScreen } = await import('../../test-support/electron-screen.js')
  return {
  screen: createTestScreen(),
  BrowserWindow: class {
    constructor() {
      return stubs.window
    }
  },
  }
})

vi.mock('../../utils/paths.js', () => ({ mainPreloadPath: '/stub/preload.cjs' }))
vi.mock('../../utils/theme.js', () => ({
  themeBg: vi.fn(() => '#ffffff'),
  syncDocumentTheme: vi.fn(),
}))
vi.mock('../navigation-hardening.js', () => ({ applyNavigationHardening: vi.fn() }))

import { syncDocumentTheme } from '../../utils/theme.js'
import { createSettingsWindow } from './create.js'

describe('createSettingsWindow theme synchronization', () => {
  it('synchronizes the settings document after its first load completes', async () => {
    await createSettingsWindow(null, '/renderer')

    const loadListener = vi.mocked(stubs.webContents.on).mock.calls
      .find(([event]) => event === 'did-finish-load')?.[1]
    expect(loadListener).toBeTypeOf('function')

    ;(loadListener as () => void)()
    expect(syncDocumentTheme).toHaveBeenCalledWith(stubs.webContents)
  })
})
