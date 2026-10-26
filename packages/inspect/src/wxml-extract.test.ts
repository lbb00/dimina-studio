import { describe, expect, it } from 'vitest'
import { resolveTagName, walkInstance } from './wxml-extract.js'
import type { ComponentInstance } from './wxml-extract.js'

function instance(type: Record<string, unknown>, extra: Record<string, unknown> = {}): ComponentInstance {
  return { type, ...extra } as ComponentInstance
}

describe('resolveTagName: authoritative Vue name = source path', () => {
  it('surfaces a custom component whose name is its full module path', () => {
    // The render runtime sets `name: componentPath` on every usingComponents
    // entry, so the panel tags the node with its source path (WeChat parity).
    expect(resolveTagName(instance({ name: '/components/ubt/index' }))).toBe('components/ubt/index')
  })

  it('surfaces a page whose name is its module path', () => {
    expect(resolveTagName(instance({ name: 'pages/tab/home/index' }))).toBe('pages/tab/home/index')
  })

  it('strips the leading slash so tags never start with `/`', () => {
    expect(resolveTagName(instance({ name: '/pages/index/index' }))).toBe('pages/index/index')
  })

  it('accepts the path off `__name` when `name` is absent', () => {
    expect(resolveTagName(instance({ __name: '/node-modules/pickpic/thumbnail/image' })))
      .toBe('node-modules/pickpic/thumbnail/image')
  })

  it('resolves from `type.name` alone, without any provides chain', () => {
    // Robustness over the legacy provide/inject reconstruction, which needed a
    // live parent provides chain; the per-type name carries the path directly.
    expect(resolveTagName(instance({ name: '/components/card/card' }, { parent: undefined, provides: undefined })))
      .toBe('components/card/card')
  })
})

describe('resolveTagName: non-path names keep the legacy fallback behavior', () => {
  it('kebab-cases a built-in PascalCase name (no slash → not a source path)', () => {
    expect(resolveTagName(instance({ name: 'ScrollView' }))).toBe('scroll-view')
  })

  it('does NOT mislabel a nameless `__scopeId` wrapper as a second page', () => {
    // A Taro template wrapper (`taro_tmpl`/`tmpl_0_3`) carries `__scopeId` but no
    // path-name and is not a page; it must fall back to `template`, never `page`.
    const wrapper = instance(
      { __scopeId: 'data-v-abc' },
      { parent: { type: { components: {} } }, appContext: { components: {} } },
    )
    expect(resolveTagName(wrapper)).not.toBe('page')
    expect(resolveTagName(wrapper)).toBe('template')
  })

  it('no longer reconstructs a path from the provides chain (heuristic removed)', () => {
    // Identity now comes solely from the authoritative `name`. An instance that
    // only carries the legacy signals (proxy.__page__ + provides.path, no
    // path-like name) is NOT upgraded to its path — it falls back like any
    // nameless __scopeId wrapper. Real pages/components always carry `name`.
    const legacy = instance(
      { __scopeId: 'data-v-x' },
      {
        proxy: { __page__: true },
        provides: { path: '/pages/legacy/legacy' },
        parent: { type: { components: {} } },
        appContext: { components: {} },
      },
    )
    expect(resolveTagName(legacy)).not.toBe('pages/legacy/legacy')
    expect(resolveTagName(legacy)).toBe('template')
  })
})

// `walkInstance` → `extractChildrenFromVNode`/`extractChildEntry` flattens a
// vnode's `children` array into zero-or-more WxmlNode entries per sibling
// (mixing raw text strings, nested DOM-typed vnodes, and component vnodes).
// Regression coverage for that flattening/ordering contract, independent of
// how it's implemented internally (spread-collect vs. append-in-place).
describe('walkInstance: children array flattening', () => {
  function domVNode(children: unknown[]): Record<string, unknown> {
    return { type: 'view', children }
  }

  it('preserves sibling order across mixed text and nested element children', () => {
    const root: ComponentInstance = {
      type: { __tagName: 'view' },
      subTree: domVNode([
        'first',
        domVNode(['second']),
        '  ',       // blank text is dropped
        domVNode(['third', domVNode(['fourth'])]),
      ]),
    }

    const node = walkInstance(root, 0)
    expect(Array.isArray(node)).toBe(false)
    const tree = node as import('./types.js').WxmlNode
    expect(tree.children.map((c) => c.text)).toEqual(['first', 'second', 'third', 'fourth'])
    expect(tree.children.every((c) => c.tagName === '#text')).toBe(true)
  })

  it('flattens a chain of nested DOM-typed elements with no tagName of their own', () => {
    // Plain (non-component) DOM vnodes never become a WxmlNode themselves —
    // only their leaf text content surfaces, at whatever depth it sits.
    const root: ComponentInstance = {
      type: { __tagName: 'view' },
      subTree: domVNode([domVNode([domVNode([domVNode(['deep text'])])])]),
    }

    const tree = walkInstance(root, 0) as import('./types.js').WxmlNode
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0]).toMatchObject({ tagName: '#text', text: 'deep text' })
  })

  it('walks a component-vnode sibling via its mounted instance, alongside plain text siblings', () => {
    const child: ComponentInstance = { type: { __tagName: 'text' }, subTree: domVNode(['child text']) }
    const root: ComponentInstance = {
      type: { __tagName: 'view' },
      subTree: domVNode(['before', { component: child }, 'after']),
    }

    const tree = walkInstance(root, 0) as import('./types.js').WxmlNode
    expect(tree.children.map((c) => c.tagName)).toEqual(['#text', 'text', '#text'])
    expect(tree.children[1]?.children[0]).toMatchObject({ tagName: '#text', text: 'child text' })
  })

  it('returns an empty children array for a vnode with no children', () => {
    const root: ComponentInstance = { type: { __tagName: 'view' }, subTree: domVNode([]) }
    const tree = walkInstance(root, 0) as import('./types.js').WxmlNode
    expect(tree.children).toEqual([])
  })
})
