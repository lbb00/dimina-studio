import { describe, expect, it } from 'vitest'
import { collectCompileDiagnostics } from './compile-diagnostics.js'

describe('collectCompileDiagnostics', () => {
  it('keeps only valid one-based ranges and deduplicates matching locations', () => {
    const diagnostic = {
      source: 'pages/index/index.ts', line: 3, column: 2, endLine: 3, endColumn: 8,
      message: 'unexpected token', severity: 'error', code: 'E_PARSE',
    }

    expect(collectCompileDiagnostics({ diagnostics: [diagnostic, diagnostic, {
      ...diagnostic, line: 0,
    }] })).toEqual([diagnostic])
  })
})
