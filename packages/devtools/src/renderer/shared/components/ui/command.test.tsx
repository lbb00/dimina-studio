import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Command, CommandInput, CommandItem, CommandList } from './command'

describe('CommandItem focus affordance', () => {
  it('marks the keyboard cursor on the selected item with a semantic ring', () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    render(
      <Command>
        <CommandInput aria-label="搜索命令" />
        <CommandList>
          <CommandItem value="one">一</CommandItem>
          <CommandItem value="two">二</CommandItem>
        </CommandList>
      </Command>,
    )
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'ArrowDown', code: 'ArrowDown' })

    const first = screen.getByRole('option', { name: '一' })
    const second = screen.getByRole('option', { name: '二' })
    expect(first.getAttribute('data-selected')).not.toBe('true')
    expect(second.getAttribute('data-selected')).toBe('true')
    expect(second.className).toContain('data-[selected=true]:ring-1')
    expect(second.className).toContain('data-[selected=true]:ring-ring')

    fireEvent.keyDown(input, { key: 'ArrowUp', code: 'ArrowUp' })
    expect(first.getAttribute('data-selected')).toBe('true')
    expect(second.getAttribute('data-selected')).not.toBe('true')
  })
})
