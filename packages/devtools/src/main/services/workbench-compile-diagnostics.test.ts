import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), off: vi.fn() } }))
import { startWorkbenchCoiServer, type WorkbenchCoiServer } from './workbench-coi-server.js'
import { createSessionStatusStore } from './workspace/session-status-store.js'
import { connectCompilerDiagnostics } from '../../../../workbench/src/compiler-diagnostics.js'
import type * as vscode from 'vscode'

let server: WorkbenchCoiServer | undefined
let request: http.ClientRequest | undefined
let root = ''
afterEach(async () => {
  request?.destroy()
  await server?.close()
  if (root) await fs.rm(root, { recursive: true, force: true })
})

it('streams original compile locations inside the active project and unsubscribes on close', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'compile-diagnostics-'))
  await fs.writeFile(path.join(root, 'index.html'), 'ok')
  const listeners = new Set<(value: unknown) => void>()
  const getSnapshot = () => ({ generation: 1, diagnostics: [
    { source: path.join(root, 'pages/index.js'), line: 3, column: 10, endLine: 3, endColumn: 11, severity: 'error', message: 'Unexpected token' },
    { source: path.join(path.dirname(root), 'outside.js'), line: 1, column: 1, endLine: 1, endColumn: 2, severity: 'error', message: 'outside' },
  ] })
  server = await startWorkbenchCoiServer({
    rootDir: root, getProjectRoot: () => root,
    getCompileStatus: getSnapshot,
    subscribeCompileStatus: (listener: (value: unknown) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as Parameters<typeof startWorkbenchCoiServer>[0])
  const chunks: string[] = []
  let onChunk: (() => void) | undefined
  const response = await new Promise<http.IncomingMessage>((resolve) => {
    request = http.get(`${server!.baseUrl}__compile/diagnostics`, resolve)
  })
  response.on('data', chunk => { chunks.push(String(chunk)); onChunk?.() })
  expect(response.statusCode).toBe(200)
  await vi.waitFor(() => expect(chunks.join('')).toContain('Unexpected token'))
  expect(chunks.join('')).toContain('pages/index.js')
  expect(chunks.join('')).not.toContain('outside.js')
  expect(chunks.join('')).not.toContain(root)
  expect(listeners.size).toBe(1)
  const update = new Promise<void>((resolve) => { onChunk = resolve })
  for (const listener of listeners) listener({ generation: 2, diagnostics: [] })
  await update
  expect(chunks.join('')).toContain('"generation":2,"diagnostics":[]')
  request!.destroy()
  await vi.waitFor(() => expect(listeners.size).toBe(0))
})

it('carries the authoritative status through HTTP into editor markers and clears them on success', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'compile-diagnostics-editor-'))
  await fs.writeFile(path.join(root, 'index.html'), 'ok')
  const status = createSessionStatusStore()
  server = await startWorkbenchCoiServer({ rootDir: root, getProjectRoot: () => root,
    getCompileStatus: status.get, subscribeCompileStatus: status.subscribe })
  const markers = new Map<string, unknown[]>()
  class Position { constructor(public line: number, public character: number) {} }
  class Range { constructor(public start: Position, public end: Position) {} }
  class Diagnostic { constructor(public range: Range, public message: string, public severity: number) {} }
  const api = {
    languages: { createDiagnosticCollection: () => ({
      clear: () => markers.clear(), set: (uri: string, items: unknown[]) => markers.set(uri, items), dispose: () => markers.clear(),
    }) },
    Uri: { parse: (value: string) => value, joinPath: (base: string, ...parts: string[]) => `${base}/${parts.map(encodeURIComponent).join('/')}` },
    Position, Range, Diagnostic, DiagnosticSeverity: { Error: 0, Warning: 1 },
  } as unknown as typeof vscode
  let response: http.IncomingMessage | undefined
  const connection = connectCompilerDiagnostics(api, server.baseUrl, (url) => {
    const source = { onmessage: null as ((event: MessageEvent<string>) => void) | null, close: () => request?.destroy() }
    let buffer = ''
    request = http.get(url, (incoming) => {
      response = incoming
      incoming.on('data', (chunk) => {
        buffer += String(chunk)
        let end: number
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const data = buffer.slice(0, end).slice('data: '.length)
          buffer = buffer.slice(end + 2)
          source.onmessage?.({ data } as MessageEvent<string>)
        }
      })
    })
    return source
  })
  try {
    status.record({ status: 'error', message: 'Unexpected token', diagnostics: [{
      source: path.join(root, 'pages/index.js'), line: 3, column: 10, endLine: 3, endColumn: 11,
      severity: 'error', message: 'Unexpected token',
    }] })
    await vi.waitFor(() => expect(markers.get('file:///workspace/pages/index.js')).toEqual([
      expect.objectContaining({ range: { start: { line: 2, character: 9 }, end: { line: 2, character: 10 } } }),
    ]))
    status.record({ status: 'ready', message: '编译完成' })
    await vi.waitFor(() => expect(markers.size).toBe(0))
    const ended = new Promise<void>((resolve) => response!.once('end', resolve))
    await server.close()
    await ended
  } finally {
    connection.dispose()
  }
})
