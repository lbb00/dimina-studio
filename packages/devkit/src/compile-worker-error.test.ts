import { describe, expect, it } from 'vitest'
import { serializeCompileError, toCompileError } from './compile-worker-error.js'

describe('compile worker diagnostic serialization', () => {
  it('preserves clone-safe diagnostics and published compiler code across IPC', () => {
    const cause = Object.assign(new Error('unexpected token'), {
      code: 'compiler-stage-error',
      diagnostics: [{
        source: 'pages/home/home.js', line: 3, column: 7, endLine: 3, endColumn: 8,
        severity: 'error' as const, message: 'Unexpected token', code: 'E_PARSE', ignored: () => {},
      }],
    })

    const restored = toCompileError(serializeCompileError(cause)) as Error & {
      code?: string; diagnostics?: unknown[]
    }
    expect(restored.message).toBe('unexpected token')
    expect(restored.code).toBe('compiler-stage-error')
    expect(restored.diagnostics).toEqual([{
      source: 'pages/home/home.js', line: 3, column: 7, endLine: 3, endColumn: 8,
      severity: 'error', message: 'Unexpected token', code: 'E_PARSE',
    }])
  })

  it('drops unknown codes and invalid or non-cloneable diagnostics', () => {
    const payload = serializeCompileError(Object.assign(new Error('ordinary'), {
      code: 'ENOENT', diagnostics: [{ source: 'x', line: 1, column: 1, severity: 'error', message: 'bad' }],
    }))
    expect(payload).toEqual({ message: 'ordinary' })
  })
})
