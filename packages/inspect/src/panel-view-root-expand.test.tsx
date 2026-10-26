/**
 * WxmlPanel root-expansion contract: the tree's root node renders expanded by
 * default. A collapsed root hides the ENTIRE tree behind a single ▸ row, so
 * the panel would open showing no structure at all — the first level must be
 * visible without a manual expand click. Guards against expand heuristics
 * that key off tag shape (e.g. component-path tags) and silently stop
 * matching the root when the runtime's tag naming changes.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { WxmlPanel } from './panel-view.js'
import type { WxmlNode } from './types.js'

const TREE: WxmlNode = {
  tagName: 'page',
  attrs: {},
  children: [
    { tagName: 'view', attrs: { class: 'container' }, children: [] },
  ],
}

describe('WxmlPanel: root renders expanded by default', () => {
  it('shows the root children without a manual expand click', () => {
    const { container } = render(<WxmlPanel tree={TREE} />)
    const text = container.textContent ?? ''
    expect(text).toContain('page')
    expect(
      text,
      'the first tree level must be visible on open — a collapsed root leaves the panel blank',
    ).toContain('container')
  })

  it('keeps non-root plain-tag nodes collapsed by default', () => {
    const nested: WxmlNode = {
      tagName: 'page',
      attrs: {},
      children: [
        {
          tagName: 'view',
          attrs: { class: 'outer' },
          children: [{ tagName: 'text', attrs: { class: 'inner-marker' }, children: [] }],
        },
      ],
    }
    const { container } = render(<WxmlPanel tree={nested} />)
    const text = container.textContent ?? ''
    expect(text).toContain('outer')
    expect(
      text,
      'depth-1 plain tags keep the collapsed default — root expansion must not cascade',
    ).not.toContain('inner-marker')
  })
})

describe('WxmlPanel: inspected marker follows inline and block rows', () => {
  it('shows the marker only on the currently inspected row', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const tree: WxmlNode = {
      tagName: 'page',
      attrs: {},
      children: [
        { tagName: 'text', attrs: {}, children: [{ tagName: '#text', attrs: {}, children: [], text: 'inline' }], sid: 'inline' },
        { tagName: 'view', attrs: {}, children: [{ tagName: 'button', attrs: {}, children: [] }], sid: 'block' },
      ],
    }
    const { container } = render(
      <WxmlPanel
        tree={tree}
        onInspectElement={async (sid) => ({
          sid,
          rect: { x: 0, y: 0, width: 1, height: 1 },
          style: { display: 'block', position: 'static', boxSizing: 'border-box', margin: '', padding: '', color: '', backgroundColor: '', fontSize: '' },
        })}
      />,
    )

    const inline = container.querySelector('[data-wxml-sid="inline"]') as HTMLElement
    const block = container.querySelector('[data-wxml-sid="block"]') as HTMLElement
    fireEvent.mouseEnter(inline)
    await waitFor(() => expect(inline.getAttribute('data-inspected')).toBe('true'))
    expect(inline.className).toContain('border-ring')
    expect(block.getAttribute('data-inspected')).toBeNull()

    fireEvent.mouseEnter(block)
    await waitFor(() => expect(block.getAttribute('data-inspected')).toBe('true'))
    expect(block.className).toContain('border-ring')
    expect(inline.getAttribute('data-inspected')).toBeNull()
  })
})
