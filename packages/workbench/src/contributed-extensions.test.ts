import { beforeEach, describe, expect, it, vi } from 'vitest'

const { registerExtension } = vi.hoisted(() => ({ registerExtension: vi.fn() }))
vi.mock('@codingame/monaco-vscode-api/extensions', () => ({
  ExtensionHostKind: { LocalWebWorker: 1 },
  registerExtension,
}))
vi.mock('./host-base-url.js', () => ({ HOST_BASE_URL: 'http://host/w/token/' }))

import { registerContributedExtensions } from './contributed-extensions.js'

function registration() {
  return { registerFileUrl: vi.fn(), whenReady: vi.fn().mockResolvedValue(undefined) }
}

describe('registerContributedExtensions', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    registerExtension.mockReset()
  })

  it('returns an empty result for missing, failed, or malformed manifests', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
    await expect(registerContributedExtensions()).resolves.toEqual({ count: 0, typings: [] })

    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await expect(registerContributedExtensions()).resolves.toEqual({ count: 0, typings: [] })

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ extensions: [] })))
    await expect(registerContributedExtensions()).resolves.toEqual({ count: 0, typings: [] })
  })

  it('isolates a malformed extension while registering later valid extensions and their files', async () => {
    const bad = { dir: 'bad', packageJson: {}, files: 'not-an-array' }
    const good = {
      dir: 'good',
      packageJson: { name: 'good', diminaWorkbench: { typings: ['types/index.d.ts'] } },
      files: ['package.json', 'extension.js', 'types/index.d.ts'],
    }
    const reg = registration()
    registerExtension.mockReturnValue(reg)
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([bad, good])))
    fetchMock.mockResolvedValueOnce(new Response('declare const good: true'))

    await expect(registerContributedExtensions()).resolves.toEqual({
      count: 1,
      typings: [{ name: 'good', content: 'declare const good: true' }],
    })
    expect(reg.registerFileUrl).toHaveBeenCalledWith(
      './extension.js',
      'http://host/w/token/__contrib/good/extension.js',
      { mimeType: 'text/javascript' },
    )
  })

  it('does not fetch a traversal path listed by an extension manifest', async () => {
    const reg = registration()
    registerExtension.mockReturnValue(reg)
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{
      dir: 'good', packageJson: { diminaWorkbench: { typings: ['../secret.d.ts'] } }, files: ['../secret.d.ts'],
    }])))

    await expect(registerContributedExtensions()).resolves.toEqual({ count: 0, typings: [] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(reg.registerFileUrl).not.toHaveBeenCalled()
  })

  it('does not treat query or fragment syntax in manifest paths as extension files', async () => {
    const reg = registration()
    registerExtension.mockReturnValue(reg)
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{
      dir: 'good?redirect', packageJson: {}, files: ['types/index.d.ts#secret'],
    }])))

    await expect(registerContributedExtensions()).resolves.toEqual({ count: 0, typings: [] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(reg.registerFileUrl).not.toHaveBeenCalled()
  })
})
