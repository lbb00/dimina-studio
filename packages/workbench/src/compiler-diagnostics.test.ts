import { expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'
import { connectCompilerDiagnostics } from './compiler-diagnostics.js'

function harness() {
  const collection = { clear: vi.fn(), set: vi.fn(), dispose: vi.fn() }
  const source = { onmessage: null as ((event: MessageEvent<string>) => void) | null, close: vi.fn() }
  const createSource = vi.fn(() => source)
  class Position { constructor(public line: number, public character: number) {} }
  class Range { constructor(public start: Position, public end: Position) {} }
  class Diagnostic { constructor(public range: Range, public message: string, public severity: number) {} }
  const api = {
    languages: { createDiagnosticCollection: vi.fn(() => collection) },
    Uri: { parse: (value: string) => value, joinPath: (root: string, ...parts: string[]) => `${root}/${parts.map(encodeURIComponent).join('/')}` },
    Position, Range, Diagnostic, DiagnosticSeverity: { Error: 0, Warning: 1 },
  } as unknown as typeof vscode
  const connection = connectCompilerDiagnostics(api, 'http://host/w/token/', createSource)
  const emit = (value: unknown) => source.onmessage?.({ data: JSON.stringify(value) } as MessageEvent<string>)
  return { collection, source, createSource, connection, emit }
}

const finding = { source: 'pages/雪 test/index.altml', line: 3, column: 10, endLine: 3, endColumn: 11, message: 'Unexpected token', severity: 'error' }

it('sets original file diagnostics and clears them after a corrected compile', () => {
  const h = harness()
  expect(h.createSource).toHaveBeenCalledWith('http://host/w/token/__compile/diagnostics')
  h.emit({ generation: 1, diagnostics: [finding] })
  expect(h.collection.set).toHaveBeenCalledWith('file:///workspace/pages/%E9%9B%AA%20test/index.altml', [expect.objectContaining({
    message: 'Unexpected token', severity: 0, source: 'dimina-compiler',
    range: { start: { line: 2, character: 9 }, end: { line: 2, character: 10 } },
  })])
  h.emit({ generation: 2, diagnostics: [] })
  expect(h.collection.clear).toHaveBeenCalledTimes(2)
})

it('忽略不完整快照，且不消耗后续有效 generation', () => {
  const h = harness()
  h.emit({ generation: 1, diagnostics: [finding] })
  for (const invalid of [null, 1, 'snapshot', {}, { generation: 2 }, { generation: 2, diagnostics: {} }, { generation: null, diagnostics: [] }, { generation: 1.5, diagnostics: [] }, { generation: Number.MAX_SAFE_INTEGER + 1, diagnostics: [] }]) {
    h.emit(invalid)
  }
  h.source.onmessage?.({ data: '{bad json' } as MessageEvent<string>)
  expect(h.collection.clear).toHaveBeenCalledTimes(1)
  h.emit({ generation: 2, diagnostics: [] })
  expect(h.collection.clear).toHaveBeenCalledTimes(2)
})

it('相同或迟到的 generation 不覆盖已有标记', () => {
  const h = harness()
  h.emit({ generation: 2, diagnostics: [finding] })
  h.emit({ generation: 2, diagnostics: [] })
  h.emit({ generation: 1, diagnostics: [] })
  expect(h.collection.clear).toHaveBeenCalledTimes(1)
  expect(h.collection.set).toHaveBeenCalledTimes(1)
})

it('拒绝不安全路径与范围，但保留同一快照的合法诊断', () => {
  const h = harness()
  h.emit({ generation: 3, diagnostics: [
    finding,
    { ...finding, source: '../outside.js' },
    { ...finding, source: '/etc/passwd' },
    { ...finding, source: 'pages//index.altml' },
    { ...finding, source: 'pages/./index.altml' },
    { ...finding, source: 'pages/../index.altml' },
    { ...finding, source: 'pages\\index.altml' },
    { ...finding, line: 0 },
    { ...finding, line: Number.MAX_SAFE_INTEGER + 1 },
    { ...finding, column: 1.5 },
    { ...finding, endLine: 2 },
    { ...finding, endColumn: 9 },
    { ...finding, severity: 'info' },
    { ...finding, source: 1 },
    { ...finding, message: null },
  ] })
  expect(h.collection.clear).toHaveBeenCalledTimes(1)
  expect(h.collection.set).toHaveBeenCalledTimes(1)
  expect(h.collection.set.mock.calls[0][1]).toHaveLength(1)
})

it('按文件分组，并只保留精确不同的错误与警告', () => {
  const h = harness()
  const warning = { ...finding, source: 'pages/other/index.altml', message: 'Deprecated API', severity: 'warning' }
  h.emit({ generation: 1, diagnostics: [finding, finding, { ...finding, message: 'Different message' }, warning] })
  expect(h.collection.set).toHaveBeenCalledTimes(2)
  const calls = h.collection.set.mock.calls
  expect(calls).toContainEqual(['file:///workspace/pages/%E9%9B%AA%20test/index.altml', expect.any(Array)])
  expect(calls).toContainEqual(['file:///workspace/pages/other/index.altml', expect.any(Array)])
  const original = calls.find(([uri]) => uri.includes('%E9%9B%AA'))?.[1]
  const other = calls.find(([uri]) => uri.includes('/other/'))?.[1]
  expect(original).toHaveLength(2)
  expect(other).toEqual([expect.objectContaining({ severity: 1, message: 'Deprecated API' })])
})

it('保留字符串 code，忽略其他 code 类型', () => {
  const h = harness()
  h.emit({ generation: 1, diagnostics: [
    { ...finding, code: 'E1001' },
    { ...finding, source: 'pages/next/index.altml', code: 1001 },
  ] })
  const diagnostics = h.collection.set.mock.calls.flatMap(([, group]) => group)
  expect(diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'E1001' }),
    expect.not.objectContaining({ code: expect.anything() }),
  ]))
})

it('disposes the source and collection once and ignores replies after disposal', () => {
  const h = harness()
  const late = h.source.onmessage
  h.connection.dispose()
  h.connection.dispose()
  late?.({ data: JSON.stringify({ generation: 1, diagnostics: [finding] }) } as MessageEvent<string>)
  expect(h.collection.set).not.toHaveBeenCalled()
  expect(h.collection.clear).not.toHaveBeenCalled()
  expect(h.source.close).toHaveBeenCalledTimes(1)
  expect(h.collection.dispose).toHaveBeenCalledTimes(1)
})
