import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(join(here, '..', 'components.json'), 'utf8')) as {
  style: string
  tailwind: { config: string; css: string; baseColor: string; cssVariables: boolean }
}

describe('shadcn component generator configuration', () => {
  it('points the v3 CLI at the repository Tailwind config', () => {
    expect(config.style).toBe('new-york')
    expect(config.tailwind.config).toBe('tailwind.config.cjs')
    expect(config.tailwind.css).toBe('src/renderer/design.css')
    expect(config.tailwind.baseColor).toBe('neutral')
    expect(config.tailwind.cssVariables).toBe(true)
  })
})
