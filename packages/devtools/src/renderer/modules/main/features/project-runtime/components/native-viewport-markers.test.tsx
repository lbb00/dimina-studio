import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('view-anchor', () => ({ createViewAnchor: () => ({ update: vi.fn(), dispose: vi.fn() }) }))
vi.mock('electron-deck/dock-react', () => ({ useDockLayoutEpoch: () => 0 }))

import { EditorPanel } from './editor-panel'
import { SimulatorPanel } from './simulator-panel'

describe('native viewport markers', () => {
  it('marks both native anchor regions for dock viewport measurement', () => {
    const { container } = render(
      <>
        <EditorPanel />
        <SimulatorPanel
          device={{ id: 'test', name: 'Test', width: 375, height: 812 } as never}
          zoom={100}
          onOpenDevicePicker={() => {}}
          onZoomChange={() => {}}
          compileStatus={{ status: 'ready', message: '' }}
          currentPage=""
          copied={false}
          onCopyPagePath={() => {}}
        />
      </>,
    )

    expect(container.querySelector('[data-area="editor"][data-deck-viewport]')).not.toBeNull()
    expect(container.querySelector('[data-area="native-simulator"][data-deck-viewport]')).not.toBeNull()
  })
})
