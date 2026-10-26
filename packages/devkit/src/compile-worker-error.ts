const COMPILER_CODES = new Set([
  'compiler-stage-error',
  'compiler-toolchain-setup-failed',
  'compiler-worker-timeout',
  'compiler-worker-crashed',
  'compiler-worker-dead',
  'compiler-toolchain-dead',
  'compiler-toolchain-unavailable',
  'compiler-output-write-failed',
  'compiler-invalid-input',
  'compiler-pool-disposed',
])

export interface CompileDiagnostic {
  source: string
  line: number
  column: number
  endLine: number
  endColumn: number
  severity: 'error' | 'warning'
  message: string
  code?: string
}

export interface SerializedCompileError {
  message: string
  code?: string
  diagnostics?: CompileDiagnostic[]
}

function diagnostic(value: unknown): CompileDiagnostic | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (typeof item.source !== 'string' || typeof item.message !== 'string') return null
  if (item.severity !== 'error' && item.severity !== 'warning') return null
  for (const field of ['line', 'column', 'endLine', 'endColumn']) {
    if (typeof item[field] !== 'number' || !Number.isFinite(item[field])) return null
  }
  return {
    source: item.source,
    line: item.line as number,
    column: item.column as number,
    endLine: item.endLine as number,
    endColumn: item.endColumn as number,
    severity: item.severity,
    message: item.message,
    ...(typeof item.code === 'string' ? { code: item.code } : {}),
  }
}

/** Keep fork IPC limited to structured, clone-safe compiler diagnostics. */
export function serializeCompileError(error: unknown): SerializedCompileError {
  const source = error && typeof error === 'object' ? error as Record<string, unknown> : null
  const diagnostics = Array.isArray(source?.diagnostics)
    ? source.diagnostics.map(diagnostic).filter((item): item is CompileDiagnostic => item !== null)
    : []
  const code = typeof source?.code === 'string' && COMPILER_CODES.has(source.code)
    ? source.code
    : undefined
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(code ? { code } : {}),
    ...(diagnostics.length ? { diagnostics } : {}),
  }
}

/** Restore public error fields after IPC without reviving arbitrary objects. */
export function toCompileError(error: SerializedCompileError): Error {
  const restored = new Error(error.message)
  if (error.code) Object.assign(restored, { code: error.code })
  if (error.diagnostics?.length) Object.assign(restored, { diagnostics: error.diagnostics })
  return restored
}
