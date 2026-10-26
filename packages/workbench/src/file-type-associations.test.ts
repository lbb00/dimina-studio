import { describe, expect, it } from 'vitest'
import { buildFileAssociations } from './file-type-associations.js'

describe('buildFileAssociations — built-in defaults', () => {
  it('returns *.wxss->css and *.wxs->javascript when called with no argument', () => {
    const result = buildFileAssociations()
    expect(result['*.wxss']).toBe('css')
    expect(result['*.wxs']).toBe('javascript')
  })

  it('returns *.wxss->css and *.wxs->javascript when called with an empty object', () => {
    const result = buildFileAssociations({})
    expect(result['*.wxss']).toBe('css')
    expect(result['*.wxs']).toBe('javascript')
  })

  it('does not include *.wxml in the associations (wxml is owned by the language extension)', () => {
    const result = buildFileAssociations()
    expect(Object.keys(result)).not.toContain('*.wxml')
  })

  it('returns exactly the two built-in entries when called with no custom types', () => {
    const result = buildFileAssociations(undefined)
    expect(Object.keys(result)).toHaveLength(2)
  })

  it('returns exactly the two built-in entries when called with an empty object', () => {
    const result = buildFileAssociations({})
    expect(Object.keys(result)).toHaveLength(2)
  })
})

describe('buildFileAssociations — template category maps to wxml', () => {
  it('maps a template extension to the wxml language id', () => {
    const result = buildFileAssociations({ template: ['altml'] })
    expect(result['*.altml']).toBe('wxml')
  })

  it('does not affect the style and viewScript categories', () => {
    const result = buildFileAssociations({ template: ['altml'] })
    expect(result['*.altml']).toBe('wxml')
    expect(Object.values(result).filter((v) => v === 'css')).toHaveLength(1)
    expect(Object.values(result).filter((v) => v === 'javascript')).toHaveLength(1)
  })
})

describe('buildFileAssociations — style category maps to css', () => {
  it('maps a style extension to the css language id', () => {
    const result = buildFileAssociations({ style: ['altss'] })
    expect(result['*.altss']).toBe('css')
  })
})

describe('buildFileAssociations — viewScript category maps to javascript', () => {
  it('maps a viewScript extension to the javascript language id', () => {
    const result = buildFileAssociations({ viewScript: ['alts'] })
    expect(result['*.alts']).toBe('javascript')
  })
})

describe('buildFileAssociations — all three categories together', () => {
  it('produces one entry per category when all three are provided', () => {
    const result = buildFileAssociations({
      template: ['altml'],
      style: ['altss'],
      viewScript: ['alts'],
    })
    expect(result['*.altml']).toBe('wxml')
    expect(result['*.altss']).toBe('css')
    expect(result['*.alts']).toBe('javascript')
  })
})

describe('buildFileAssociations — extension normalization', () => {
  it('strips a single leading dot before accepting the extension', () => {
    const result = buildFileAssociations({ template: ['.altml'] })
    expect(result['*.altml']).toBe('wxml')
    expect(Object.keys(result)).not.toContain('*.*.altml')
    expect(Object.keys(result)).not.toContain('*..altml')
  })

  it('strips multiple leading dots before accepting the extension', () => {
    const result = buildFileAssociations({ template: ['...altml'] })
    expect(result['*.altml']).toBe('wxml')
  })

  it('lowercases uppercase extensions', () => {
    const result = buildFileAssociations({ template: ['altml'] })
    expect(result['*.altml']).toBe('wxml')
    expect(Object.keys(result)).not.toContain('*.ALTML')
  })

  it('trims surrounding whitespace before normalizing', () => {
    const result = buildFileAssociations({ template: ['  .altml '] })
    expect(result['*.altml']).toBe('wxml')
  })

  it('treats ".altml", "altml", and "  .altml " as the same extension', () => {
    const a = buildFileAssociations({ template: ['altml'] })
    const b = buildFileAssociations({ template: ['.altml'] })
    const c = buildFileAssociations({ template: ['  .altml '] })
    expect(a['*.altml']).toBe('wxml')
    expect(b['*.altml']).toBe('wxml')
    expect(c['*.altml']).toBe('wxml')
    expect(Object.keys(a)).toEqual(Object.keys(b))
    expect(Object.keys(a)).toEqual(Object.keys(c))
  })
})

describe('buildFileAssociations — invalid extensions are dropped', () => {
  it('drops an empty string extension', () => {
    const result = buildFileAssociations({ template: [''] })
    expect(Object.keys(result)).toHaveLength(2)
  })

  it('drops an extension containing a forward slash', () => {
    const result = buildFileAssociations({ template: ['foo/bar'] })
    expect(Object.keys(result)).toHaveLength(2)
  })

  it('drops an extension containing an internal dot (path-bearing)', () => {
    // A dot after the leading-dot strip phase is a metachar and must be rejected.
    const result = buildFileAssociations({ template: ['foo.bar'] })
    expect(Object.keys(result)).toHaveLength(2)
  })

  it('drops an extension containing an internal space', () => {
    const result = buildFileAssociations({ template: ['foo bar'] })
    expect(Object.keys(result)).toHaveLength(2)
  })

  it('drops an extension containing a wildcard metacharacter', () => {
    const result = buildFileAssociations({ template: ['foo*'] })
    expect(Object.keys(result)).toHaveLength(2)
  })

  it('drops non-string items in the array', () => {
    // The type allows `string[]` but runtime callers may pass mixed arrays.
    const result = buildFileAssociations({ template: [42 as unknown as string, null as unknown as string] })
    expect(Object.keys(result)).toHaveLength(2)
  })

  it('keeps valid items and drops invalid items from the same array', () => {
    const result = buildFileAssociations({ template: ['altml', '', 'bad/ext', '.valid'] })
    expect(result['*.altml']).toBe('wxml')
    expect(result['*.valid']).toBe('wxml')
    expect(Object.keys(result)).not.toContain('*.')
    expect(Object.keys(result)).not.toContain('*.bad/ext')
  })
})

describe('buildFileAssociations — built-in collision guard', () => {
  it('skips a template extension that matches the built-in "js" extension', () => {
    const result = buildFileAssociations({ template: ['js'] })
    // js is a built-in; the custom entry must be silently dropped.
    expect(result['*.js']).toBeUndefined()
    expect(Object.keys(result)).toHaveLength(2)
  })

  it('skips a style extension that matches the built-in "wxss" extension', () => {
    const result = buildFileAssociations({ style: ['wxss'] })
    // wxss is already a built-in source extension; must not be reclassified.
    expect(result['*.wxss']).toBe('css')
    expect(Object.keys(result)).toHaveLength(2)
  })

  it('skips a viewScript extension that matches the built-in "ts" extension', () => {
    const result = buildFileAssociations({ viewScript: ['ts'] })
    expect(result['*.ts']).toBeUndefined()
    expect(Object.keys(result)).toHaveLength(2)
  })

  it('skips a template extension that matches the built-in "wxml" extension', () => {
    const result = buildFileAssociations({ template: ['wxml'] })
    // wxml is in the built-in reserved set even though it is not in the associations map.
    expect(result['*.wxml']).toBeUndefined()
    expect(Object.keys(result)).toHaveLength(2)
  })

  it('skips a template extension that matches the built-in "css" extension', () => {
    const result = buildFileAssociations({ template: ['css'] })
    expect(result['*.css']).toBeUndefined()
    expect(Object.keys(result)).toHaveLength(2)
  })
})

describe('buildFileAssociations — fresh object per call', () => {
  it('returns a new object on each call so mutations do not bleed between calls', () => {
    const first = buildFileAssociations({ template: ['altml'] })
    // Mutate the first result.
    first['*.injected'] = 'injected'

    const second = buildFileAssociations({ template: ['altml'] })
    expect(second['*.injected']).toBeUndefined()
  })
})
