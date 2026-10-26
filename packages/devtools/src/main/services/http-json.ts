/**
 * Minimal JSON responder for the workbench COI server.
 */
import type http from 'node:http'

export function jsonRes(res: http.ServerResponse, code: number, obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length })
  res.end(body)
}
