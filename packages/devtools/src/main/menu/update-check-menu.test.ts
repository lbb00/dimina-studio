import { describe, expect, it, vi } from 'vitest'

const menu = vi.hoisted(() => ({
  buildFromTemplate: vi.fn((template: unknown) => template),
  setApplicationMenu: vi.fn(),
}))

vi.mock('electron', () => ({ Menu: menu }))

import { installAppMenu } from './index.js'
import type { MenuContext } from '../../shared/types.js'

function makeContext(checkForUpdates?: () => void): MenuContext {
  return {
    appName: 'Test',
    workspace: {
      hasActiveSession: () => false,
      getProjectPath: () => '',
      openProject: async () => ({ success: true }),
      closeProject: async () => {},
      getSession: () => null,
    },
    openSettings: async () => {},
    notify: {
      projectStatus: () => {},
      windowNavigateBack: () => {},
    },
    ...(checkForUpdates ? { checkForUpdates } : {}),
  }
}

function appSubmenu(): Array<{ label?: string; click?: () => void }> {
  const template = menu.buildFromTemplate.mock.calls.at(-1)?.[0] as Array<{
    label?: string
    submenu?: Array<{ label?: string; click?: () => void }>
  }>
  return template.find((item) => item.label === 'Dimina DevTools')?.submenu ?? []
}

describe('built-in update menu', () => {
  it('omits the check action when no update checker is configured', () => {
    installAppMenu(makeContext())

    expect(appSubmenu().find((item) => item.label === '检查更新')).toBeUndefined()
  })

  it('routes the check action through the supplied live callback', () => {
    const checkForUpdates = vi.fn()
    installAppMenu(makeContext(checkForUpdates))

    appSubmenu().find((item) => item.label === '检查更新')?.click?.()

    expect(checkForUpdates).toHaveBeenCalledTimes(1)
  })
})
