import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMapConfig } from './map-config.cjs'

describe('buildMapConfig authorize()', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('throws an actionable message naming the missing env var when no key is configured', () => {
    const cfg = buildMapConfig({})

    expect(() => cfg.authorize()).toThrow('AMap Web key is required')
    expect(() => cfg.authorize()).toThrow('DIMINA_AMAP_WEB_KEY')
  })

  it('logs the missing-key message to the console before throwing, so the env var is visible somewhere', () => {
    const cfg = buildMapConfig({})

    expect(() => cfg.authorize()).toThrow()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('DIMINA_AMAP_WEB_KEY'))
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('AMap Web key is required'))
  })

  it('throws naming the consent env var when a key is set but consent is missing', () => {
    const cfg = buildMapConfig({ key: 'k1' })

    expect(() => cfg.authorize()).toThrow('DIMINA_AMAP_PRIVACY_CONSENT')
  })

  it('logs the missing-consent message to the console before throwing, so the env var is visible somewhere', () => {
    const cfg = buildMapConfig({ key: 'k1' })

    expect(() => cfg.authorize()).toThrow()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('DIMINA_AMAP_PRIVACY_CONSENT'))
  })

  it('throws naming the consent env var when consent is set but not truthy', () => {
    const cfg = buildMapConfig({ key: 'k1', consent: 'nope' })

    expect(() => cfg.authorize()).toThrow('DIMINA_AMAP_PRIVACY_CONSENT')
  })

  it.each(['1', 'true', 'TRUE'])('returns true synchronously when key is set and consent is %s', (consent) => {
    const cfg = buildMapConfig({ key: 'k1', consent })

    expect(cfg.authorize()).toBe(true)
  })
})

describe('buildMapConfig shape', () => {
  it('always reports the amap provider', () => {
    expect(buildMapConfig({}).provider).toBe('amap')
  })

  it('exposes an empty, writable providers object for host-side registration', () => {
    const cfg = buildMapConfig({})

    expect(cfg.providers).toEqual({})
    expect(() => { cfg.providers.foo = {} }).not.toThrow()
  })

  it('trims the key before exposing it on providerOptions.amap', () => {
    const cfg = buildMapConfig({ key: '  k1  ' })

    expect(cfg.providerOptions.amap.key).toBe('k1')
  })

  it('prefers serviceHost over securityJsCode when both are given', () => {
    const cfg = buildMapConfig({ key: 'k1', serviceHost: 'https://host', securityJsCode: 'sec' })

    expect(cfg.providerOptions.amap.serviceHost).toBe('https://host')
    expect(cfg.providerOptions.amap.securityJsCode).toBeUndefined()
  })

  it('carries only key when neither serviceHost nor securityJsCode is given', () => {
    const cfg = buildMapConfig({ key: 'k1' })

    expect(Object.keys(cfg.providerOptions.amap)).toEqual(['key'])
  })

  it('gives each call an independent providers object (per-page isolation)', () => {
    const cfgA = buildMapConfig({})
    const cfgB = buildMapConfig({})

    cfgA.providers.amap = { create: () => {} }

    expect(cfgB.providers).toEqual({})
  })
})
