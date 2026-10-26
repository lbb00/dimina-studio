import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'update-checker-test-'))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => tempRoot) } }))

import { createGitHubReleaseChecker } from './github-release-checker.js'

const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  fs.rmSync(tempRoot, { recursive: true, force: true })
  fs.mkdirSync(tempRoot)
})

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
  return `http://127.0.0.1:${address.port}`
}

describe('GitHub release downloads', () => {
  it('keeps concurrent same-basename downloads in separate files', async () => {
    const origin = await serve((request, response) => {
      const body = request.url === '/release/one/package.dmg' ? 'first bytes' : 'second bytes'
      response.writeHead(200, { 'content-length': String(Buffer.byteLength(body)) })
      response.end(body)
    })
    const checker = createGitHubReleaseChecker({ owner: 'owner', repo: 'repo' })

    const [first, second] = await Promise.all([
      checker.downloadUpdate({ version: '1.0.0', downloadUrl: `${origin}/release/one/package.dmg` }),
      checker.downloadUpdate({ version: '2.0.0', downloadUrl: `${origin}/release/two/package.dmg` }),
    ])

    expect(first).not.toBe(second)
    expect(path.basename(first)).toBe('package.dmg')
    expect(path.basename(second)).toBe('package.dmg')
    expect(fs.readFileSync(first, 'utf8')).toBe('first bytes')
    expect(fs.readFileSync(second, 'utf8')).toBe('second bytes')
  })

  it('removes the per-download directory when a transfer fails', async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(200, { 'content-length': '10', connection: 'close' })
      response.flushHeaders()
      response.write('short')
      response.socket?.destroy()
    })
    const checker = createGitHubReleaseChecker({ owner: 'owner', repo: 'repo' })

    await expect(checker.downloadUpdate({ version: '1.0.0', downloadUrl: `${origin}/package.dmg` })).rejects.toThrow(/aborted|reset/i)

    expect(fs.readdirSync(tempRoot)).toEqual([])
  })
})
