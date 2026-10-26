import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { PlacementPublisher } from 'electron-deck/client'
import { PlacementPublisherContext } from '@/shared/placement-publisher-context'
import { VIEW_ID, type DevtoolsExtra } from '../../../../../../shared/view-ids'
import { DEVICE_NAMES, findDevice } from '@devicekit/devices'

const epoch = vi.hoisted(() => ({ current: 0 }))
vi.mock('electron-deck/dock-react', () => ({ useDockLayoutEpoch: () => epoch.current }))

import { SimulatorPanel } from './simulator-panel'
import { EditorPanel } from './editor-panel'

const device = findDevice(DEVICE_NAMES.iPhone_X)!
const publish = vi.fn()
const remove = vi.fn()
const publisher = { set: publish, remove, dispose: vi.fn() } as unknown as PlacementPublisher<DevtoolsExtra>
let rect = { x: 100, y: 80, width: 400, height: 600 }

beforeEach(() => {
  epoch.current = 0
  rect = { x: 100, y: 80, width: 400, height: 600 }
  publish.mockClear()
  remove.mockClear()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect(rect))
  // 不执行观察回调或动画帧，保证新位置来自提交后的立即测量。
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', Observer)
  vi.stubGlobal('IntersectionObserver', Observer)
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function panel(kind: 'simulator' | 'editor', copied = false) {
  return <PlacementPublisherContext.Provider value={publisher}>
    {kind === 'editor' ? <EditorPanel /> : <SimulatorPanel
      device={device} zoom={100} onOpenDevicePicker={() => {}} onZoomChange={() => {}}
      compileStatus={{ status: 'ready', message: '' }} currentPage="pages/index/index"
      copied={copied} onCopyPagePath={() => {}}
    />}
  </PlacementPublisherContext.Provider>
}

function latest(kind: 'simulator' | 'editor') {
  return publish.mock.calls.filter(([value]) => value.viewId === VIEW_ID[kind === 'editor' ? 'workbench' : 'simulator']).at(-1)?.[0].placement
}

describe.each(['simulator', 'editor'] as const)('%s 布局提交后的原生视图位置', (kind) => {
  it('同尺寸移动后立即发布新位置，无关渲染不重复发布', () => {
    const view = render(panel(kind))
    expect(latest(kind)).toEqual({ visible: true, bounds: rect })
    publish.mockClear()
    rect = { ...rect, x: 500 }
    epoch.current++
    view.rerender(panel(kind))
    expect(latest(kind)).toEqual({ visible: true, bounds: rect })
    publish.mockClear()
    view.rerender(panel(kind, true))
    expect(publish).not.toHaveBeenCalled()
  })

  it('隐藏后恢复和第二次移动都使用当前布局，卸载后重新挂载可用', () => {
    const view = render(panel(kind))
    rect = { x: 0, y: 0, width: 0, height: 0 }
    epoch.current++
    view.rerender(panel(kind))
    expect(latest(kind)).toEqual({ visible: false })
    rect = { x: 500, y: 80, width: 400, height: 600 }
    epoch.current++
    view.rerender(panel(kind))
    expect(latest(kind)).toEqual({ visible: true, bounds: rect })
    rect = { ...rect, x: 100 }
    epoch.current++
    view.rerender(panel(kind))
    expect(latest(kind)).toEqual({ visible: true, bounds: rect })
    view.unmount()
    expect(remove).toHaveBeenCalledWith(VIEW_ID[kind === 'editor' ? 'workbench' : 'simulator'])
    publish.mockClear()
    render(panel(kind))
    expect(latest(kind)).toEqual({ visible: true, bounds: rect })
  })
})
