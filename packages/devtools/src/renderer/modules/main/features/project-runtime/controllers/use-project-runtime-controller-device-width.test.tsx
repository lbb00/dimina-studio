import { act, renderHook } from '@testing-library/react'
import { DEFAULT_DEVICE } from '@devicekit/devices'
import { frameOuterSize } from '@devicekit/frame'
import { describe, expect, it, vi } from 'vitest'
import { SIM_PANEL_PADDING } from '@/shared/constants'

const sessionSeam = vi.hoisted(() => ({
  compileStatus: { status: 'compiling', message: '正在编译' },
}))

vi.mock('@/shared/api', () => ({
  setNativeDeviceInfo: vi.fn(),
  showDevicePicker: vi.fn(),
  onDevicePickerSelected: vi.fn(() => () => {}),
}))

vi.mock('./use-session', () => ({
  useSession: vi.fn(() => ({
    compileStatus: sessionSeam.compileStatus,
    appInfo: null,
    port: 0,
    pages: [],
    entryPagePath: '',
    compileModes: { revision: 0, selectedId: 'default', modes: [] },
    compileModesReady: false,
    compileConfig: { startPage: '', scene: 0, queryParams: [] },
    hotReloadToken: 0,
    relaunchNonce: 0,
    compileEvents: [],
    compileLogs: [],
    clearCompileEvents: vi.fn(),
    relaunch: vi.fn(),
    runtimeStatus: null,
    watcherDead: false,
  })),
}))

vi.mock('./use-simulator', () => ({
  useSimulator: vi.fn(() => ({ simulatorUrl: '', currentPage: '', currentRoute: '' })),
}))

vi.mock('./use-panel-data', () => ({
  usePanelData: vi.fn(() => ({
    wxmlSource: {}, wxmlEnabled: false,
    storageSource: {}, storageEnabled: false,
    appDataSource: {}, appDataEnabled: false,
  })),
}))

vi.mock('./use-right-pane', () => ({
  useRightPane: vi.fn(() => ({
    rightPane: { selected: 'simulator', simulatorVisible: true },
    selectRightPane: vi.fn(),
    toggleRightPaneVisible: vi.fn(),
  })),
}))

vi.mock('./use-popover', () => ({
  usePopover: vi.fn(() => ({ showCompilePanel: false, toggleCompilePanel: vi.fn() })),
}))

import { useProjectRuntimeController } from './use-project-runtime-controller'

function changeEvent(value: string): React.ChangeEvent<HTMLSelectElement> {
  return { target: { value } } as React.ChangeEvent<HTMLSelectElement>
}

describe('useProjectRuntimeController: simulator width ownership', () => {
  it('keeps a manually dragged width when compilation becomes ready again', () => {
    sessionSeam.compileStatus = { status: 'ready', message: '编译完成' }
    const { result, rerender } = renderHook(() =>
      useProjectRuntimeController({ projectPath: '/tmp/fake-project' }),
    )

    act(() => {
      result.current.device.setSimPanelWidth(333)
    })
    sessionSeam.compileStatus = { status: 'compiling', message: '正在重新编译' }
    rerender()
    sessionSeam.compileStatus = { status: 'ready', message: '编译完成' }
    rerender()

    expect(result.current.device.simPanelWidth).toBe(333)
  })

  it('keeps the numeric zoom-derived width when compilation becomes ready again', () => {
    sessionSeam.compileStatus = { status: 'ready', message: '编译完成' }
    const { result, rerender } = renderHook(() =>
      useProjectRuntimeController({ projectPath: '/tmp/fake-project' }),
    )
    const expected = Math.ceil(frameOuterSize(DEFAULT_DEVICE, 'portrait').width * 0.5 + SIM_PANEL_PADDING * 2)

    act(() => {
      result.current.device.handleZoomChange(changeEvent('50'))
    })
    expect(result.current.device.simPanelWidth).toBe(expected)

    sessionSeam.compileStatus = { status: 'compiling', message: '正在重新编译' }
    rerender()
    sessionSeam.compileStatus = { status: 'ready', message: '编译完成' }
    rerender()

    expect(result.current.device.simPanelWidth).toBe(expected)
  })
})
