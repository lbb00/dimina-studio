export interface CompileDiagnostic {
  source: string
  line: number
  column: number
  endLine: number
  endColumn: number
  message: string
  severity: 'error' | 'warning'
  code?: string
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isValidRange(diagnostic: CompileDiagnostic): boolean {
  return diagnostic.endLine > diagnostic.line
    || (diagnostic.endLine === diagnostic.line && diagnostic.endColumn >= diagnostic.column)
}

function toCompileDiagnostic(value: unknown): CompileDiagnostic | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (typeof item.source !== 'string' || typeof item.message !== 'string') return null
  if (item.severity !== 'error' && item.severity !== 'warning') return null
  const { line, column, endLine, endColumn } = item
  if (!isPositiveInteger(line) || !isPositiveInteger(column)
    || !isPositiveInteger(endLine) || !isPositiveInteger(endColumn)) return null
  const diagnostic: CompileDiagnostic = {
    source: item.source,
    line,
    column,
    endLine,
    endColumn,
    message: item.message,
    severity: item.severity,
    ...(typeof item.code === 'string' ? { code: item.code } : {}),
  }
  return isValidRange(diagnostic) ? diagnostic : null
}

/** Extracts clone-safe compiler diagnostics without trusting arbitrary errors. */
export function collectCompileDiagnostics(error: unknown): CompileDiagnostic[] {
  if (!error || typeof error !== 'object') return []
  const values = (error as { diagnostics?: unknown }).diagnostics
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  return values.flatMap((value) => {
    const diagnostic = toCompileDiagnostic(value)
    if (!diagnostic) return []
    const key = [diagnostic.source, diagnostic.line, diagnostic.column, diagnostic.endLine, diagnostic.endColumn, diagnostic.message].join('\u0000')
    if (seen.has(key)) return []
    seen.add(key)
    return [diagnostic]
  })
}
