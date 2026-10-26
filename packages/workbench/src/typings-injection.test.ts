import { describe, expect, it, vi } from 'vitest'
import type { IFileService } from '@codingame/monaco-vscode-api'

vi.mock('@codingame/monaco-vscode-api/vscode/vs/base/common/uri', () => ({
  URI: { parse: (value: string) => ({ toString: () => value }) },
}))
vi.mock('@codingame/monaco-vscode-api/vscode/vs/base/common/buffer', () => ({
  VSBuffer: { fromString: (value: string) => ({ toString: () => value }) },
}))
vi.mock('./file-workspace', () => ({
  WORKSPACE_FILE_ROOT: 'file:///workspace',
  TYPES_ROOT: 'node_modules/@types',
}))

import { seedAmbientTypings } from './typings-injection.js'

function makeFileService(initial: Record<string, string> = {}, readFailure = false) {
  const files = new Map(Object.entries(initial))
  const fileService = {
    exists: vi.fn(async (uri: { toString(): string }) => files.has(uri.toString())),
    readFile: vi.fn(async (uri: { toString(): string }) => {
      if (readFailure) throw new Error('memfs read failed')
      const value = files.get(uri.toString())
      if (value === undefined) throw new Error('not found')
      return { value: { toString: () => value } }
    }),
    writeFile: vi.fn(async (uri: { toString(): string }, value: { toString(): string }) => {
      files.set(uri.toString(), value.toString())
    }),
  }
  return { files, fileService: fileService as unknown as IFileService }
}

describe('seedAmbientTypings', () => {
  it('writes built-in and contributed packages and merges JSONC types without duplicates', async () => {
    const { files, fileService } = makeFileService({
      'file:///workspace/tsconfig.json': '{ // comment\n "compilerOptions": { "types": ["node", "dimina",], }, }',
    })

    await seedAmbientTypings(fileService, [{ name: 'host-editor', content: 'declare const host: string' }])

    expect(files.get('file:///workspace/node_modules/@types/dimina/index.d.ts')).toContain('declare')
    expect(files.get('file:///workspace/node_modules/@types/host-editor/index.d.ts')).toBe('declare const host: string')
    expect(JSON.parse(files.get('file:///workspace/tsconfig.json')!)).toMatchObject({
      compilerOptions: { types: ['node', 'dimina', 'host-editor'] },
    })
  })

  it('does not create a config when the workspace has none', async () => {
    const { files, fileService } = makeFileService()
    await seedAmbientTypings(fileService)
    expect(files.has('file:///workspace/tsconfig.json')).toBe(false)
    expect(files.has('file:///workspace/jsconfig.json')).toBe(false)
  })

  it('preserves an existing config when it cannot be read or parsed', async () => {
    const original = '{ user content that must not be replaced'
    const { files, fileService } = makeFileService({ 'file:///workspace/tsconfig.json': original }, true)
    await expect(seedAmbientTypings(fileService)).resolves.toBeUndefined()
    expect(files.get('file:///workspace/tsconfig.json')).toBe(original)

    const parsed = makeFileService({ 'file:///workspace/tsconfig.json': original })
    await expect(seedAmbientTypings(parsed.fileService)).resolves.toBeUndefined()
    expect(parsed.files.get('file:///workspace/tsconfig.json')).toBe(original)
  })
})
