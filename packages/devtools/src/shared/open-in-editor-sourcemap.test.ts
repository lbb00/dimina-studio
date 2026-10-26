import { readFile, rm } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { SourceMapConsumer } from 'source-map-js'
import { afterEach, describe, expect, it } from 'vitest'
import { resourceUrlToProjectRelativePath } from './open-in-editor.js'

const resourceBaseUrl = 'http://localhost:64576/'
const appId = 'source_map_fixture'
const context = {
  projectRoot: '',
  resourceBaseUrl,
  appId,
  outputRoot: 'main',
}

const temporaryRoots: string[] = []
const execFile = promisify(execFileCallback)

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('source map resource URLs', () => {
  it('maps a same-origin URL resolved from an absolute project source back to its project-relative path', () => {
    const projectRoot = '/tmp/源 码 project'
    const source = '../../../../../../tmp/源 码 project/pages/index/index.js'
    const resourceUrl = new URL(source, `${resourceBaseUrl}${appId}/main/logic.js.map`).href

    expect(resourceUrlToProjectRelativePath(resourceUrl, {
      ...context,
      projectRoot,
    })).toBe('pages/index/index.js')
  })

  it('keeps compiled package paths while rejecting outside paths and build frames', () => {
    const projectRoot = '/tmp/源 码 project'
    const scopedContext = { ...context, projectRoot }

    expect(resourceUrlToProjectRelativePath(
      `${resourceBaseUrl}${appId}/main/subpkg/pages/cart/index.js`,
      scopedContext,
    )).toBe('subpkg/pages/cart/index.js')
    expect(resourceUrlToProjectRelativePath('http://localhost:64577/tmp/源 码 project/pages/index/index.js', scopedContext)).toBeNull()
    expect(resourceUrlToProjectRelativePath(`${resourceBaseUrl}tmp/another-project/pages/index/index.js`, scopedContext)).toBeNull()
    expect(resourceUrlToProjectRelativePath(`${resourceBaseUrl}${appId}/main/common.js`, scopedContext)).toBeNull()
  })

  it('maps a percent-encoded Windows project path without treating its drive as a relative segment', () => {
    expect(resourceUrlToProjectRelativePath(
      `${resourceBaseUrl}C%3A/Users/Alice/%E5%B0%8F%E7%A8%8B%E5%BA%8F/pages/index/index.ts`,
      {
        ...context,
        projectRoot: 'C:\\Users\\Alice\\小程序',
      },
    )).toBe('pages/index/index.ts')
  })

  it('shows why a relative compiler source cannot recover a disk root from a short HTTP map URL', async () => {
    const script = path.resolve(process.cwd(), 'scripts/generate-source-map-fixture.js')
    const { stdout } = await execFile(process.execPath, [script])
    const fixture = JSON.parse(stdout) as {
      root: string
      projectRoot: string
      maps: { main: string; subpackage: string }
      sourcePaths: { main: string; subpackage: string }
      appId: string
    }
    temporaryRoots.push(fixture.root)

    for (const [kind, mapPath, sourcePath, outputPath] of [
      ['main', fixture.maps.main, fixture.sourcePaths.main, 'main/logic.js.map'],
      ['subpackage', fixture.maps.subpackage, fixture.sourcePaths.subpackage, 'sub_packages/feature/logic.js.map'],
    ] as const) {
      const mapUrl = new URL(`${resourceBaseUrl}${fixture.appId}/${outputPath}`)
      const map = JSON.parse(await readFile(mapPath, 'utf8'))
      const consumer = await new SourceMapConsumer(map)
      const source = map.sources.find((value: string) => value.endsWith(sourcePath.endsWith('.ts') ? '.ts' : '.js'))
      const mapping = consumer.allGeneratedPositionsFor({ source, line: 1, column: 0 })[0]
      expect(mapping, `${kind} map must preserve original positions`).toBeDefined()
      if (!mapping) throw new Error(`${kind} map has no generated position`)
      const original = consumer.originalPositionFor(mapping)
      expect(original.source).toBeTruthy()
      const sourceUrl = new URL(original.source!, mapUrl).href
      const relative = resourceUrlToProjectRelativePath(sourceUrl, { ...context, projectRoot: fixture.projectRoot })
      expect(relative).toBe(`${path.basename(fixture.projectRoot)}/${path.relative(fixture.projectRoot, sourcePath)}`)
      await expect(readFile(path.join(fixture.projectRoot, relative!), 'utf8')).rejects.toThrow()
      await expect(readFile(sourcePath, 'utf8')).resolves.not.toBe('')
      expect(original.line).toBeGreaterThan(0)
      expect(original.column).toBeGreaterThanOrEqual(0)
    }
  })
})
