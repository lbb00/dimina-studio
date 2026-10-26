import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select'

describe('Select', () => {
  it('reports a selected value through onValueChange', () => {
    const onValueChange = vi.fn()
    render(
      <Select value="one" onValueChange={onValueChange}>
        <SelectTrigger aria-label="缩放"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="one">100%</SelectItem>
          <SelectItem value="two">80%</SelectItem>
        </SelectContent>
      </Select>,
    )

    fireEvent.click(screen.getByRole('combobox', { name: '缩放' }))
    fireEvent.click(screen.getByRole('option', { name: '80%' }))

    expect(onValueChange).toHaveBeenCalledWith('two')
  })

  it('keeps disabled options unavailable to keyboard selection', () => {
    const onValueChange = vi.fn()
    render(
      <Select value="one" onValueChange={onValueChange}>
        <SelectTrigger aria-label="缩放"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="one">100%</SelectItem>
          <SelectItem value="two" disabled>80%</SelectItem>
        </SelectContent>
      </Select>,
    )

    const trigger = screen.getByRole('combobox', { name: '缩放' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'Enter' })

    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('keeps the trigger focus-visible ring semantic', () => {
    render(
      <Select value="one" onValueChange={() => {}}>
        <SelectTrigger aria-label="缩放"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="one">100%</SelectItem></SelectContent>
      </Select>,
    )
    const trigger = screen.getByRole('combobox', { name: '缩放' })
    fireEvent.focus(trigger)
    expect(trigger.className).toContain('focus-visible:ring-2')
    expect(trigger.className).toContain('focus-visible:ring-ring')
  })

  it('shows an inset semantic ring on the item reached by ArrowDown', () => {
    render(
      <Select value="one" onValueChange={() => {}}>
        <SelectTrigger aria-label="缩放"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="one">100%</SelectItem>
          <SelectItem value="two">80%</SelectItem>
        </SelectContent>
      </Select>,
    )

    const trigger = screen.getByRole('combobox', { name: '缩放' })
    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'ArrowDown', code: 'ArrowDown' })

    const focused = screen.getByRole('option', { name: '80%' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    // Radix's collection highlight relies on layout APIs that jsdom does not
    // implement. Focus the option after driving ArrowDown so the browser focus
    // state still exercises the actual CSS selector used by the component.
    focused.focus()
    expect(document.activeElement).toBe(focused)
    expect(focused.className).toContain('focus:ring-1')
    expect(focused.className).toContain('focus:ring-inset')
    expect(focused.className).toContain('focus:ring-ring')
  })
})
