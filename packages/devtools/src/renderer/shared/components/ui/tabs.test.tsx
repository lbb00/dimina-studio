import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Tabs, TabsList, TabsTrigger } from './tabs'

describe('Tabs segment active affordance', () => {
  it('moves the active state while retaining a small bottom marker', () => {
    const { getByRole } = render(
      <Tabs defaultValue="one" variant="segment">
        <TabsList>
          <TabsTrigger value="one">一</TabsTrigger>
          <TabsTrigger value="two">二</TabsTrigger>
        </TabsList>
      </Tabs>,
    )
    const first = getByRole('tab', { name: '一' })
    const second = getByRole('tab', { name: '二' })
    expect(first.getAttribute('data-state')).toBe('active')
    expect(first.className).toContain('data-[state=active]:after:bg-ring')

    fireEvent.keyDown(second, { key: 'Enter', code: 'Enter' })
    expect(first.getAttribute('data-state')).toBe('inactive')
    expect(second.getAttribute('data-state')).toBe('active')
  })
})
