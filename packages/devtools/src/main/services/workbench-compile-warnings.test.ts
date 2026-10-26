import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type * as vscode from 'vscode'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), off: vi.fn() } }))

import { startWorkbenchCoiServer, type WorkbenchCoiServer } from './workbench-coi-server.js'
import { createSessionStatusStore } from './workspace/session-status-store.js'
import { connectCompilerDiagnostics } from '../../../../workbench/src/compiler-diagnostics.js'

type Marker = { range: { start: { line: number; character: number }; end: { line: number; character: number } }; message: string; severity: number }

let server: WorkbenchCoiServer | undefined
let root = ''
const requests = new Set<http.ClientRequest>()
const connections: Array<{ dispose: () => void }> = []

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.dispose()
  for (const request of requests) request.destroy()
  requests.clear()
  await server?.close()
  server = undefined
  if (root) await fs.rm(root, { recursive: true, force: true })
  root = ''
})

function warning(source: string) {
  return {
    source,
    line: 3,
    column: 7,
    endLine: 3,
    endColumn: 14,
    severity: 'warning' as const,
    message: 'Unsupported or undeclared component: <notatag>',
    code: 'compat-undeclared-component',
  }
}

async function connect() {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'compile-warnings-'))
  await fs.writeFile(path.join(root, 'index.html'), 'ok')
  const status = createSessionStatusStore()
  server = await startWorkbenchCoiServer({
    rootDir: root,
    getProjectRoot: () => root,
    getCompileStatus: status.get,
    subscribeCompileStatus: status.subscribe,
  })
  const markers = new Map<string, Marker[]>()
  class Position { constructor(public line: number, public character: number) {} }
  class Range { constructor(public start: Position, public end: Position) {} }
  class Diagnostic { constructor(public range: Range, public message: string, public severity: number) {} }
  const api = {
    languages: { createDiagnosticCollection: () => ({
      clear: () => markers.clear(),
      set: (uri: string, items: Marker[]) => markers.set(uri, items),
      dispose: () => markers.clear(),
    }) },
    Uri: { parse: (value: string) => value, joinPath: (base: string, ...parts: string[]) => `${base}/${parts.map(encodeURIComponent).join('/')}` },
    Position, Range, Diagnostic, DiagnosticSeverity: { Error: 0, Warning: 1 },
  } as unknown as typeof vscode
  let opened!: () => void
  const openedSse = new Promise<void>((resolve) => { opened = resolve })
  const connection = connectCompilerDiagnostics(api, server.baseUrl, (url) => {
    const source = { onmessage: null as ((event: MessageEvent<string>) => void) | null, close: () => request.destroy() }
    let buffer = ''
    const request = http.get(url, (incoming) => {
      opened()
      incoming.on('data', (chunk) => {
        buffer += String(chunk)
        let end = buffer.indexOf('\n\n')
        while (end !== -1) {
          const data = buffer.slice(0, end).slice('data: '.length)
          buffer = buffer.slice(end + 2)
          source.onmessage?.({ data } as MessageEvent<string>)
          end = buffer.indexOf('\n\n')
        }
      })
    })
    requests.add(request)
    return source
  })
  connections.push(connection)
  await openedSse
  return { status, markers }
}

function markerFor(markers: Map<string, Marker[]>) {
  return markers.get('file:///workspace/pages/index/index.wxml')
}

it('maps a successful compile warning to its original UTF-16 editor range and warning severity', async () => {
  const { status, markers } = await connect()
  status.record({ status: 'ready', message: '编译完成', diagnostics: [warning(path.join(root, 'pages/index/index.wxml'))] })

  await vi.waitFor(() => expect(markerFor(markers)).toEqual([
    expect.objectContaining({
      range: { start: { line: 2, character: 6 }, end: { line: 2, character: 13 } },
      message: 'Unsupported or undeclared component: <notatag>', severity: 1,
    }),
  ]))
})

it('keeps the last build warning when watcher-dead status has no build findings', async () => {
  const { status, markers } = await connect()
  status.record({ status: 'ready', message: '编译完成', diagnostics: [warning(path.join(root, 'pages/index/index.wxml'))] })
  await vi.waitFor(() => expect(markerFor(markers)).toHaveLength(1))
  status.record({ status: 'ready', message: '文件监听已停止', watcher: 'dead' })

  await vi.waitFor(() => expect(markerFor(markers)).toHaveLength(1))
  expect(status.get()).toMatchObject({ watcherAlive: false, diagnostics: [expect.objectContaining({ severity: 'warning' })] })
})

it('拒绝打开项目的状态更新不会通过 SSE 清空现有编辑器警告', async () => {
  const { status, markers } = await connect()
  const finding = warning(path.join(root, 'pages/index/index.wxml'))
  status.record({ status: 'ready', message: '编译完成', diagnostics: [finding] })
  await vi.waitFor(() => expect(markerFor(markers)).toHaveLength(1))

  status.record({ status: 'error', message: 'permission denied', diagnostics: [finding] })

  await vi.waitFor(() => expect(markerFor(markers)).toHaveLength(1))
  expect(status.get()).toMatchObject({ phase: 'error', diagnostics: [finding] })
})

it('clears editor warnings when a successful build explicitly returns no diagnostics', async () => {
  const { status, markers } = await connect()
  status.record({ status: 'ready', message: '编译完成', diagnostics: [warning(path.join(root, 'pages/index/index.wxml'))] })
  await vi.waitFor(() => expect(markerFor(markers)).toHaveLength(1))
  status.record({ status: 'ready', message: '编译完成', diagnostics: [] })

  await vi.waitFor(() => expect(markers.size).toBe(0))
})

it('restores the same warning when it is introduced by a later successful build', async () => {
  const { status, markers } = await connect()
  status.record({ status: 'ready', message: '编译完成', diagnostics: [warning(path.join(root, 'pages/index/index.wxml'))] })
  await vi.waitFor(() => expect(markerFor(markers)).toHaveLength(1))
  status.record({ status: 'ready', message: '编译完成', diagnostics: [] })
  await vi.waitFor(() => expect(markers.size).toBe(0))
  status.record({ status: 'ready', message: '编译完成', diagnostics: [warning(path.join(root, 'pages/index/index.wxml'))] })

  await vi.waitFor(() => expect(markerFor(markers)).toHaveLength(1))
})

it('clears editor warnings when the workspace returns to idle', async () => {
  const { status, markers } = await connect()
  status.record({ status: 'ready', message: '编译完成', diagnostics: [warning(path.join(root, 'pages/index/index.wxml'))] })
  await vi.waitFor(() => expect(markerFor(markers)).toHaveLength(1))
  status.record({ status: 'idle', message: '', diagnostics: [] })

  await vi.waitFor(() => expect(markers.size).toBe(0))
})
