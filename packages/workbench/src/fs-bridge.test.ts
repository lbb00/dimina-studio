import { describe, expect, it, vi } from 'vitest'
import {
  bridgeDelete,
  bridgeRead,
  bridgeReaddir,
  bridgeWrite,
  relFromWorkspaceUri,
} from './fs-bridge.js'

describe('fs bridge HTTP contract', () => {
  it('maps an inactive workspace to an empty directory, while other bridge failures retain their status', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(bridgeReaddir('http://host/w/token/', '.')).resolves.toEqual([])
    await expect(bridgeReaddir('http://host/w/token/', '.')).rejects.toThrow('readdir .: 500')
    await expect(bridgeRead('http://host/w/token/', 'missing.js')).rejects.toMatchObject({ status: 404 })
  })

  it('uses POST and query encoding for writes and deletes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await bridgeWrite('http://host/w/token/', 'a file/雪.js', new Uint8Array([1, 2]))
    await bridgeDelete('http://host/w/token/', 'a file/雪.js')

    expect(fetchMock.mock.calls[0]).toEqual([
      'http://host/w/token/__fs/write?p=a+file%2F%E9%9B%AA.js',
      expect.objectContaining({ method: 'POST', body: new Uint8Array([1, 2]) }),
    ])
    expect(fetchMock.mock.calls[1]).toEqual([
      'http://host/w/token/__fs/delete?p=a+file%2F%E9%9B%AA.js',
      { method: 'POST' },
    ])
  })
})

describe('relFromWorkspaceUri', () => {
  it('keeps ordinary workspace files and excludes injected tooling', () => {
    expect(relFromWorkspaceUri({ toString: () => 'file:///workspace/pages/home.js' })).toBe('pages/home.js')
    expect(relFromWorkspaceUri({ toString: () => 'file:///workspace/node_modules/@types/dimina/index.d.ts' })).toBeNull()
    expect(relFromWorkspaceUri({ toString: () => 'file:///workspace/tsconfig.json' })).toBeNull()
  })

  it('rejects decoded traversal, encoded separators, and malformed encodings', () => {
    for (const href of [
      'file:///workspace/%2e%2e/secret.js',
      'file:///workspace/pages%2F..%2Fsecret.js',
      'file:///workspace/%E0%A4%A',
    ]) {
      expect(relFromWorkspaceUri({ toString: () => href })).toBeNull()
    }
  })

  it('rejects an empty leading segment instead of returning an absolute bridge path', () => {
    expect(relFromWorkspaceUri({ toString: () => 'file:///workspace//absolute.js' })).toBeNull()
    expect(relFromWorkspaceUri({ toString: () => 'file:///workspace/pages/nested/file.js' })).toBe('pages/nested/file.js')
  })
})
