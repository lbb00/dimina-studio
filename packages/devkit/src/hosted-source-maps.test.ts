import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createNodeCompilerPool } from '@dimina-studio/compiler/pool-node'
import { SourceMapConsumer } from 'source-map-js'
import { afterEach, describe, expect, it } from 'vitest'

import { normalizeHostedSourceMaps } from './hosted-source-maps.js'

const temporaryRoots: string[] = []

async function fixture(): Promise<{ root: string; projectRoot: string; publishedRoot: string }> {
	const root = await mkdtemp(path.join(os.tmpdir(), 'hosted-source-map-'))
	temporaryRoots.push(root)
	const projectRoot = path.join(root, 'project')
	const publishedRoot = path.join(root, 'out', 'fixture-app')
	await mkdir(path.join(projectRoot, 'pages/index'), { recursive: true })
	await mkdir(path.join(publishedRoot, 'sub_packages/feature'), { recursive: true })
	await writeFile(path.join(projectRoot, 'pages/index/index.ts'), 'const answer: number = 42\n')
	await writeFile(path.join(publishedRoot, 'logic.js.map'), JSON.stringify({
		version: 3,
		sources: ['../../project/pages/index/index.ts', 'https://example.test/external.ts', '/pages/index/index.wxml'],
		sourcesContent: ['const answer: number = 42\n', 'external', '<view/>'],
		names: [],
		mappings: 'AAAA',
	}))
	await writeFile(path.join(publishedRoot, 'sub_packages/feature/logic.js.map'), JSON.stringify({
		version: 3,
		sources: ['../../../../project/pages/index/index.ts'],
		sourcesContent: ['const answer: number = 42\n'],
		names: [],
		mappings: 'AAAA',
	}))
	return { root, projectRoot, publishedRoot }
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }))))
})

describe('normalizeHostedSourceMaps', () => {
	it('preserves valid indexed source maps without rejecting their sections', async () => {
		const { root, projectRoot, publishedRoot } = await fixture()
		const indexed = { version: 3, sections: [{ offset: { line: 0, column: 0 }, map: { version: 3, sources: ['virtual.ts'], names: [], mappings: 'AAAA' } }] }
		await writeFile(path.join(publishedRoot, 'logic.js.map'), JSON.stringify(indexed))
		await normalizeHostedSourceMaps({ outputDir: path.join(root, 'out'), appId: 'fixture-app', projectRoot })
		expect(JSON.parse(await readFile(path.join(publishedRoot, 'logic.js.map'), 'utf8'))).toEqual(indexed)
	})

	it('canonicalizes only current-project sources in nested published maps while preserving mappings and sourcesContent', async () => {
		const { root, projectRoot, publishedRoot } = await fixture()

		await normalizeHostedSourceMaps({ outputDir: path.join(root, 'out'), appId: 'fixture-app', projectRoot })

		const main = JSON.parse(await readFile(path.join(publishedRoot, 'logic.js.map'), 'utf8'))
		const subpackage = JSON.parse(await readFile(path.join(publishedRoot, 'sub_packages/feature/logic.js.map'), 'utf8'))
		expect(main.sources[0]).toBe(pathToFileURL(path.join(projectRoot, 'pages/index/index.ts')).href)
		expect(main.sources.slice(1)).toEqual(['https://example.test/external.ts', '/pages/index/index.wxml'])
		expect(main.sourcesContent).toEqual(['const answer: number = 42\n', 'external', '<view/>'])
		expect(main.mappings).toBe('AAAA')
		expect(subpackage.sources).toEqual([pathToFileURL(path.join(projectRoot, 'pages/index/index.ts')).href])

		const consumer = await new SourceMapConsumer(main)
		expect(consumer.originalPositionFor({ line: 1, column: 0 }).source).toBe(main.sources[0])
	})

	it('keeps the original source location when sourceRoot participates in source resolution', async () => {
		const { root, projectRoot, publishedRoot } = await fixture()
		const mapPath = path.join(publishedRoot, 'logic.js.map')
		await writeFile(mapPath, JSON.stringify({ version: 3, sourceRoot: '../../project',
			sources: ['pages/index/index.ts', '../outside/missing.ts'], names: [], mappings: 'AAAA' }))
		await normalizeHostedSourceMaps({ outputDir: path.join(root, 'out'), appId: 'fixture-app', projectRoot })
		const map = JSON.parse(await readFile(mapPath, 'utf8'))
		const consumer = new SourceMapConsumer(map)
		expect(consumer.originalPositionFor({ line: 1, column: 0 }).source)
			.toBe(pathToFileURL(path.join(projectRoot, 'pages/index/index.ts')).href)
		expect(path.resolve(publishedRoot, map.sourceRoot ?? '', map.sources[1]))
			.toBe(path.resolve(publishedRoot, '../../project', '../outside/missing.ts'))
	})

	it('preserves the opened project identity when its root is a directory alias', async () => {
		const { root, projectRoot, publishedRoot } = await fixture()
		const alias = path.join(root, 'opened-project')
		await symlink(projectRoot, alias, 'dir')
		await normalizeHostedSourceMaps({ outputDir: path.join(root, 'out'), appId: 'fixture-app', projectRoot: alias })
		const map = JSON.parse(await readFile(path.join(publishedRoot, 'logic.js.map'), 'utf8'))
		expect(map.sources[0]).toBe(pathToFileURL(path.join(alias, 'pages/index/index.ts')).href)
		await expect(readFile(new URL(map.sources[0]), 'utf8')).resolves.toContain('const answer')
	})

	it('does not follow published-output symlinks', async () => {
		const { root, projectRoot, publishedRoot } = await fixture()
		const external = path.join(root, 'external-map-dir')
		await mkdir(external)
		await writeFile(path.join(external, 'escaped.js.map'), '{"not":"a source map"}')
		await symlink(external, path.join(publishedRoot, 'linked'), 'dir')

		await expect(normalizeHostedSourceMaps({ outputDir: path.join(root, 'out'), appId: 'fixture-app', projectRoot })).resolves.toBeUndefined()
		await expect(readFile(path.join(external, 'escaped.js.map'), 'utf8')).resolves.toBe('{"not":"a source map"}')
	})

	it('fails before publication when a map is malformed and leaves it untouched', async () => {
		const { root, projectRoot, publishedRoot } = await fixture()
		const malformed = path.join(publishedRoot, 'broken.js.map')
		await writeFile(malformed, '{not json')

		await expect(normalizeHostedSourceMaps({ outputDir: path.join(root, 'out'), appId: 'fixture-app', projectRoot }))
			.rejects.toThrow(/hosted source map/i)
		await expect(readFile(malformed, 'utf8')).resolves.toBe('{not json')
	})

	it('canonicalizes a real compiler JS, TS, and subpackage map without changing the pool default', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'hosted-source-map-real-'))
		temporaryRoots.push(root)
		const projectRoot = path.join(root, '项目 with 空格')
		const outputDir = path.join(root, 'out')
		const appId = 'hosted_source_map_fixture'
		await mkdir(path.join(projectRoot, 'pages/index'), { recursive: true })
		await mkdir(path.join(projectRoot, 'packages/feature/pages/detail'), { recursive: true })
		await Promise.all([
			writeFile(path.join(projectRoot, 'app.js'), 'App({})'),
			writeFile(path.join(projectRoot, 'app.json'), JSON.stringify({ pages: ['pages/index/index'], subpackages: [{ root: 'packages/feature', pages: ['pages/detail/index'] }] })),
			writeFile(path.join(projectRoot, 'project.config.json'), JSON.stringify({ appid: appId })),
			writeFile(path.join(projectRoot, 'pages/index/index.json'), '{}'),
			writeFile(path.join(projectRoot, 'pages/index/index.wxml'), '<view>{{count}}</view>'),
			writeFile(path.join(projectRoot, 'pages/index/index.ts'), 'const count: number = 1\nPage({ data: { count } })\n'),
			writeFile(path.join(projectRoot, 'packages/feature/pages/detail/index.json'), '{}'),
			writeFile(path.join(projectRoot, 'packages/feature/pages/detail/index.wxml'), '<view>detail</view>'),
			writeFile(path.join(projectRoot, 'packages/feature/pages/detail/index.js'), 'Page({ data: { detail: true } })\n'),
		])
		const pool = createNodeCompilerPool()
		try {
			const appInfo = await pool.build(outputDir, projectRoot, true, { sourcemap: true })
			expect(appInfo?.path).toBe('pages/index/index')
			const mainPath = path.join(outputDir, appId, 'main/logic.js.map')
			const subpackagePath = path.join(outputDir, appId, 'sub_packages/feature/logic.js.map')
			const before = JSON.parse(await readFile(mainPath, 'utf8'))
			expect(before.sources.some((source: string) => source.endsWith('/pages/index/index.ts'))).toBe(true)
			expect(before.sources.every((source: string) => !source.startsWith('file:'))).toBe(true)

			await normalizeHostedSourceMaps({ outputDir, appId: appInfo!.appId, projectRoot })

			const main = JSON.parse(await readFile(mainPath, 'utf8'))
			const subpackage = JSON.parse(await readFile(subpackagePath, 'utf8'))
			const appUrl = pathToFileURL(path.join(projectRoot, 'app.js')).href
			const tsUrl = pathToFileURL(path.join(projectRoot, 'pages/index/index.ts')).href
			const jsUrl = pathToFileURL(path.join(projectRoot, 'packages/feature/pages/detail/index.js')).href
			expect(main.sources).toContain(appUrl)
			expect(main.sources).toContain(tsUrl)
			expect(subpackage.sources).toContain(jsUrl)
			for (const [map, sourceUrl] of [[main, appUrl], [main, tsUrl], [subpackage, jsUrl]] as const) {
				const consumer = await new SourceMapConsumer(map)
				const generated = consumer.allGeneratedPositionsFor({ source: sourceUrl, line: 1, column: 0 })[0]
				expect(generated).toBeDefined()
				if (!generated) throw new Error(`real source map has no generated position for ${sourceUrl}`)
				const original = consumer.originalPositionFor(generated)
				expect(original).toMatchObject({ source: sourceUrl, line: expect.any(Number), column: expect.any(Number) })
				await expect(readFile(fileURLToPath(sourceUrl), 'utf8')).resolves.not.toBe('')
			}
		}
		finally {
			await pool.dispose()
		}
	})
})
