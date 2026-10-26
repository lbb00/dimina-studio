import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button } from './button'

describe('Button toolbar active affordance', () => {
  it('keeps active state data-driven and exposes a small bottom marker utility', () => {
    const { getByRole, rerender } = render(
      <Button variant="toolbar" data-active="false">布局</Button>,
    )
    const button = getByRole('button')
    expect(button.getAttribute('data-active')).toBe('false')
    expect(button.className).toContain('data-[active=true]:after:bg-ring')

    rerender(<Button variant="toolbar" data-active="true">布局</Button>)
    fireEvent.focus(button)
    expect(button.getAttribute('data-active')).toBe('true')
    expect(button.className).toContain('data-[active=true]:after:bottom-0')
  })
})
