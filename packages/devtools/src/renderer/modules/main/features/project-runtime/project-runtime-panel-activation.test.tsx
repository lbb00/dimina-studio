import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/shared/types'

const opened = vi.hoisted(() => ({ handler: null as (() => void) | null, listeners: [] as Array<() => void> }))
const dock = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }))

vi.mock('@/shared/api', () => ({
  getBranding: vi.fn(async () => ({ appName: 'Test' })),
  onHostToolbarHeightChanged: vi.fn(() => () => {}),
  getHostToolbarHeight: vi.fn(async () => 0),
  openInternalDevtools: vi.fn(),
  onEditorOpenFile: vi.fn((handler: () => void) => {
    opened.handler = handler
    opened.listeners.push(handler)
    return () => { if (opened.handler === handler) opened.handler = null }
  }),
  publishSimulatorDevtoolsBounds: vi.fn(),
  publishHostToolbarBounds: vi.fn(),
  publishPlacementSnapshot: vi.fn(),
}))

vi.mock('./controllers/use-project-runtime-controller', () => ({
  useProjectRuntimeController: () => ({
    session: { compileStatus: { status: 'ready', message: '' }, compileModes: { selectedId: null, entries: [] }, compileEvents: [], compileLogs: [], clearCompileEvents: vi.fn(), relaunch: vi.fn() },
    device: { device: { id: 'test', name: 'Test', width: 375, height: 812 }, zoom: 100, simPanelWidth: 375, openDevicePicker: vi.fn(), handleDeviceChange: vi.fn(), handleZoomChange: vi.fn() },
    simulator: { currentRoute: '', currentPage: '' },
    panelData: { wxmlSource: {}, wxmlEnabled: false, storageSource: {}, storageEnabled: false, appDataSource: {}, appDataEnabled: false },
    rightPane: { rightPane: { selected: 'wxml' }, selectRightPane: vi.fn() },
    popover: { compileDropdownRef: { current: null }, showCompilePanel: false, toggleCompilePanel: vi.fn() },
  }),
}))
vi.mock('./controllers/use-layout-store', () => ({ useLayoutStore: () => ({ state: { dockTree: null }, setDockTree: vi.fn() }) }))
vi.mock('./components/project-toolbar', () => ({ ProjectToolbar: () => null }))
vi.mock('./components/simulator-panel', () => ({ SimulatorPanel: () => null }))
vi.mock('./components/editor-panel', () => ({ EditorPanel: () => null }))
vi.mock('../bottom-debug-panel/bottom-debug-panel', () => ({ DebugTabContent: () => null }))
vi.mock('electron-deck/dock-react', () => ({ DockView: (props: Record<string, unknown>) => { dock.props.push(props); return <div data-testid="dock" /> } }))
vi.mock('view-anchor/react', () => ({ useViewAnchor: () => () => {} }))
vi.mock('view-anchor', () => ({ createViewAnchor: () => ({ update: vi.fn(), dispose: vi.fn() }) }))

import { ProjectRuntime } from './project-runtime'

const PROJECT: Project = { name: 'Test', path: '/tmp/project-runtime-panel-activation' }

beforeEach(() => { opened.handler = null; opened.listeners.length = 0; dock.props.length = 0 })

describe('ProjectRuntime editor open activation', () => {
  it('reopens through the canonical model and emits a fresh editor activation for every open request', () => {
    render(<ProjectRuntime project={PROJECT} />)
    const first = dock.props.at(-1)!
    const model = first.model as { get: () => unknown }
    expect(JSON.stringify(model.get())).not.toContain('"editor"')

    act(() => opened.handler?.())
    const afterFirst = dock.props.at(-1)!
    act(() => opened.handler?.())
    const afterSecond = dock.props.at(-1)!

    expect(JSON.stringify(model.get())).toContain('"editor"')
    expect(afterFirst.panelActivation).toEqual({ panelId: 'editor', epoch: 1 })
    expect(afterSecond.panelActivation).toEqual({ panelId: 'editor', epoch: 2 })
    expect(afterSecond.minimumViewportHeight).toBe(200)
    expect(afterSecond.minimumViewportWidth).toBe(200)
  })

  it('ignores a late source-open callback after the runtime is destroyed', () => {
    const rendered = render(<ProjectRuntime project={PROJECT} />)
    const model = dock.props.at(-1)!.model as { get: () => unknown }
    const stale = opened.listeners.at(-1)
    const before = JSON.stringify(model.get())

    rendered.unmount()
    act(() => stale?.())

    expect(JSON.stringify(model.get())).toBe(before)
  })
})
