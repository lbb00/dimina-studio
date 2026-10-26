/**
 * Normalized parser diagnostics can cross worker and process boundaries without
 * relying on an Oxc-specific Error object or its formatted code frame.
 */
export class CompilerDiagnosticsError extends Error {
  constructor(diagnostics) {
    const first = diagnostics[0]
    super(`[compiler] parse failed ${first.source}:${first.line}:${first.column}: ${first.message}`)
    this.name = 'CompilerDiagnosticsError'
    this.code = 'compiler-stage-error'
    this.diagnostics = diagnostics
  }
}

function positionAt(sourceText, offset) {
  const end = Math.max(0, Math.min(offset, sourceText.length))
  let line = 1
  let column = 1
  for (let index = 0; index < end; index += 1) {
    if (sourceText[index] === '\n') {
      line += 1
      column = 1
    } else {
      column += 1
    }
  }
  return { line, column }
}

/**
 * Oxc label offsets are UTF-16 string indexes. Keep that convention so editor
 * selections use the same coordinates as JavaScript strings and LSP positions.
 */
export function diagnosticsFromOxcErrors(errors, filename, sourceText) {
  return errors.map((error) => {
    const label = error.labels?.[0]
    const start = label?.start ?? 0
    const end = label?.end ?? start
    const startPosition = positionAt(sourceText, start)
    const endPosition = positionAt(sourceText, end)
    const severity = error.severity === 'Warning' ? 'warning' : 'error'
    return {
      source: filename,
      line: startPosition.line,
      column: startPosition.column,
      endLine: endPosition.line,
      endColumn: endPosition.column,
      severity,
      message: label?.message || error.message || 'Parse error',
      ...(error.code ? { code: String(error.code) } : {}),
    }
  })
}

export function isCompilerDiagnosticsError(error) {
  return error instanceof CompilerDiagnosticsError
}

/**
 * Run the installed Oxc parser and reject only diagnostics that make its AST
 * unsafe to consume. Warnings stay attached to Oxc's parse result unchanged.
 */
export function parseSyncOrThrow(rawParseSync, filename, sourceText, options) {
  const result = rawParseSync(filename, sourceText, options)
  const diagnostics = diagnosticsFromOxcErrors(result.errors || [], filename, sourceText)
  const severe = diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
  if (severe.length > 0) throw new CompilerDiagnosticsError(severe)
  return result
}
