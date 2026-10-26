import path from 'node:path'
import type { ServerResponse } from 'node:http'
import type { CompileDiagnostic } from '../../shared/compile-diagnostics.js'

export interface CompileDiagnosticsSnapshot {
  generation: number
  diagnostics: readonly CompileDiagnostic[]
}

export interface CompileDiagnosticsStreamOptions {
  getProjectRoot: () => string
  getCompileStatus?: () => CompileDiagnosticsSnapshot
  subscribeCompileStatus?: (listener: (snapshot: CompileDiagnosticsSnapshot) => void) => () => void
}

/** A stream belongs to one editor request and unsubscribes with that request. */
export function createCompileDiagnosticsStream(options: CompileDiagnosticsStreamOptions) {
  const streams = new Map<ServerResponse, () => void>()
  let closed = false
  return {
    handle(res: ServerResponse): void {
      if (closed || !options.getCompileStatus || !options.subscribeCompileStatus) {
        res.writeHead(204)
        res.end()
        return
      }
      const send = (snapshot: CompileDiagnosticsSnapshot) => {
        if (res.destroyed || res.writableEnded) return
        const root = options.getProjectRoot()
        const diagnostics = root ? snapshot.diagnostics.flatMap(diagnostic => {
          const relative = path.relative(root, diagnostic.source)
          if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return []
          return [{ ...diagnostic, source: relative.split(path.sep).join('/') }]
        }) : []
        res.write(`data: ${JSON.stringify({ generation: snapshot.generation, diagnostics })}\n\n`)
      }
      let unsubscribe = () => {}
      const stop = () => {
        if (!streams.delete(res)) return
        res.off('close', stop)
        unsubscribe()
      }
      streams.set(res, stop)
      res.once('close', stop)
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform' })
      try {
        unsubscribe = options.subscribeCompileStatus(send)
        send(options.getCompileStatus())
      } catch (error) {
        stop()
        res.end()
        throw error
      }
    },
    close(): void {
      closed = true
      for (const [res, stop] of [...streams]) {
        stop()
        res.end()
      }
    },
  }
}
