import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import { describe, expect, it } from 'vitest'

import tailwindConfig from '../../tailwind.config.cjs'

describe('renderer animation utilities', () => {
  it('generates enter, fade, zoom, and slide utilities used by overlays', async () => {
    const css = await postcss([
      tailwindcss({
        ...tailwindConfig,
        content: [{ raw: '<div class="animate-in animate-out fade-in-0 fade-out-0 zoom-in-95 zoom-out-95 slide-in-from-top slide-out-to-right"></div>', extension: 'html' }],
      }),
    ]).process('@tailwind utilities;', { from: undefined })

    expect(css.css).toContain('.animate-in')
    expect(css.css).toContain('@keyframes enter')
    expect(css.css).toContain('.fade-in-0')
    expect(css.css).toContain('.zoom-in-95')
    expect(css.css).toContain('.slide-out-to-right')
  })
})
