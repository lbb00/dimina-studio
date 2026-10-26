import type * as vscode from 'vscode'

interface StreamSource {
  onmessage: ((event: MessageEvent<string>) => void) | null
  close(): void
}

interface CompileDiagnostic {
  source: string
  line: number
  column: number
  endLine: number
  endColumn: number
  message: string
  severity: 'error' | 'warning'
  code?: string
}

interface DiagnosticSnapshot {
  generation: number
  diagnostics: unknown[]
}

interface PositionedDiagnostic extends Record<string, unknown> {
  line: number
  column: number
  endLine: number
  endColumn: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function validPosition(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function validSource(source: string): boolean {
  const parts = source.split('/')
  return !source.includes('\\') && !parts.some((part) => !part || part === '.' || part === '..')
}

function validRange(diagnostic: Record<string, unknown>): diagnostic is PositionedDiagnostic {
  const { line, column, endLine, endColumn } = diagnostic
  if (!validPosition(line) || !validPosition(column) || !validPosition(endLine) || !validPosition(endColumn)) return false
  return endLine > line || (endLine === line && endColumn >= column)
}

function parseSnapshot(value: string): DiagnosticSnapshot | null {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return null }
  if (!isRecord(parsed) || !validGeneration(parsed.generation) || !isUnknownArray(parsed.diagnostics)) return null
  return { generation: parsed.generation, diagnostics: parsed.diagnostics }
}

function parseDiagnostic(value: unknown): CompileDiagnostic | null {
  if (!isRecord(value) || typeof value.source !== 'string' || typeof value.message !== 'string') return null
  if (value.severity !== 'error' && value.severity !== 'warning') return null
  if (!validSource(value.source) || !validRange(value)) return null
  const diagnostic: CompileDiagnostic = {
    source: value.source,
    line: value.line,
    column: value.column,
    endLine: value.endLine,
    endColumn: value.endColumn,
    message: value.message,
    severity: value.severity,
  }
  if (typeof value.code === 'string') diagnostic.code = value.code
  return diagnostic
}

function diagnosticKey(diagnostic: CompileDiagnostic): string {
  const { source, line, column, endLine, endColumn, message, severity } = diagnostic
  return JSON.stringify([source, line, column, endLine, endColumn, message, severity])
}

function toVscodeDiagnostic(api: typeof vscode, item: CompileDiagnostic): vscode.Diagnostic {
  const range = new api.Range(new api.Position(item.line - 1, item.column - 1), new api.Position(item.endLine - 1, item.endColumn - 1))
  const severity = item.severity === 'error' ? api.DiagnosticSeverity.Error : api.DiagnosticSeverity.Warning
  const diagnostic = new api.Diagnostic(range, item.message, severity)
  diagnostic.source = 'dimina-compiler'
  if (item.code !== undefined) diagnostic.code = item.code
  return diagnostic
}

function collectDiagnostics(api: typeof vscode, items: unknown[]): Map<string, vscode.Diagnostic[]> {
  const groups = new Map<string, vscode.Diagnostic[]>()
  const seen = new Set<string>()
  for (const value of items) {
    const item = parseDiagnostic(value)
    if (!item) continue
    const key = diagnosticKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    const group = groups.get(item.source) ?? []
    group.push(toVscodeDiagnostic(api, item))
    groups.set(item.source, group)
  }
  return groups
}

/** Compiler locations arrive from the same scoped host as the editor's files. */
export function connectCompilerDiagnostics(
  api: typeof vscode,
  baseUrl: string,
  createSource: (url: string) => StreamSource = (url) => new EventSource(url),
): vscode.Disposable {
  const collection = api.languages.createDiagnosticCollection('dimina-compiler')
  const source = createSource(new URL('__compile/diagnostics', baseUrl).href)
  let generation = -1
  let disposed = false
  source.onmessage = (event) => {
    if (disposed) return
    const snapshot = parseSnapshot(event.data)
    if (!snapshot || snapshot.generation <= generation) return
    const groups = collectDiagnostics(api, snapshot.diagnostics)
    generation = snapshot.generation
    collection.clear()
    for (const [relative, diagnostics] of groups) {
      collection.set(api.Uri.joinPath(api.Uri.parse('file:///workspace'), ...relative.split('/')), diagnostics)
    }
  }
  return {
    dispose() {
      if (disposed) return
      disposed = true
      source.onmessage = null
      source.close()
      collection.dispose()
    },
  }
}
