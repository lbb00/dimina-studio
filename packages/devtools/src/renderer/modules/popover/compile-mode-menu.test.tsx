import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CompileModeMenu } from './compile-mode-menu'

const callbacks = {
  onSelect: vi.fn(),
  onEdit: vi.fn(),
  onCreate: vi.fn(),
  onCreateFromCurrentPage: vi.fn(),
}

function renderMenu(selectedId: string | null) {
  return render(
    <CompileModeMenu
      state={{
        selectedId,
        entries: [
          { id: 'custom', mode: { name: '调试模式', pathName: 'pages/debug', query: '', scene: null } },
        ],
      }}
      entryPagePath="pages/index"
      currentRoute="pages/index"
      {...callbacks}
    />,
  )
}

describe('CompileModeMenu selection indicator', () => {
  it('renders one fixed-column check only for the selected mode', () => {
    renderMenu('custom')
    const rows = screen.getAllByTestId('compile-mode-row')
    expect(rows).toHaveLength(2)
    expect(screen.getAllByTestId('compile-mode-selected-indicator')).toHaveLength(1)
    expect(screen.getByRole('menuitemradio', { name: '调试模式' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemradio', { name: '普通编译' })).toHaveAttribute('aria-checked', 'false')
  })
})
