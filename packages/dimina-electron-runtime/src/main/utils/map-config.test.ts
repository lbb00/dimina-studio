import { describe, expect, it } from 'vitest'
import { resolveMapConfigEnv } from './map-config.js'

describe('resolveMapConfigEnv', () => {
  it('reports every field as undefined when the env has none of them', () => {
    expect(resolveMapConfigEnv({})).toEqual({
      key: undefined,
      securityJsCode: undefined,
      serviceHost: undefined,
      consent: undefined,
    })
  })

  it('reports a whitespace-only value as undefined', () => {
    expect(resolveMapConfigEnv({ DIMINA_AMAP_WEB_KEY: '   ' }).key).toBeUndefined()
  })

  it('trims surrounding whitespace from a configured value', () => {
    expect(resolveMapConfigEnv({ DIMINA_AMAP_WEB_KEY: '  k1  ' }).key).toBe('k1')
  })

  it.each([
    ['DIMINA_AMAP_WEB_KEY', 'key'],
    ['DIMINA_AMAP_SECURITY_JS_CODE', 'securityJsCode'],
    ['DIMINA_AMAP_SERVICE_HOST', 'serviceHost'],
    ['DIMINA_AMAP_PRIVACY_CONSENT', 'consent'],
  ] as const)('resolves %s independently of the other three fields', (envVar, field) => {
    const result = resolveMapConfigEnv({ [envVar]: 'v' })

    expect(result[field]).toBe('v')
    for (const otherField of ['key', 'securityJsCode', 'serviceHost', 'consent'] as const) {
      if (otherField === field) continue
      expect(result[otherField]).toBeUndefined()
    }
  })
})
