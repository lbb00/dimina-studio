import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
const pkg = require_('../package.json') as {
  exports: Record<string, unknown>
  publishConfig: { exports: Record<string, unknown> }
  files: string[]
}
const root = dirname(fileURLToPath(import.meta.url)) + '/..'

describe('css subpath', () => {
  // `postcss-import` (used by the Tailwind CLI, webpack and every plain-PostCSS
  // setup) resolves bare specifiers with the `resolve` package, which predates
  // and ignores `exports`. It therefore looks for the literal path
  // node_modules/@dimina-studio/design/css/index.css on disk. Vite's own resolver
  // does honour `exports`, so mapping ./css/* at some other physical location
  // works here and breaks for consumers — the exact people this
  // package exists for. Keep the specifier and the directory identical.
  it.each(['index.css', 'tokens.css', 'base.css', 'deck.css'])(
    'css/%s sits at the path its specifier names',
    name => {
      expect(existsSync(join(root, 'css', name))).toBe(true)
    },
  )

  it('does not ship the removed legacy stylesheet', () => {
    const removedFile = ['cor', 'netto', '-tokens.css'].join('')
    expect(existsSync(join(root, 'css', removedFile))).toBe(false)
  })

  it('is exported at its own physical path, in dev and when published', () => {
    expect(pkg.exports['./css/*']).toBe('./css/*')
    expect(pkg.publishConfig.exports['./css/*']).toBe('./css/*')
  })

  it('ships the css directory', () => {
    expect(pkg.files).toContain('css')
  })
})
