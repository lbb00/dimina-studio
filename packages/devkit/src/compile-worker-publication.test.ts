import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createNodeCompilerPool } from '@dimina-studio/compiler/pool-node'
import { expect, it } from 'vitest'
import { createCompileWorkerHandler } from './compile-worker-entry.js'

it('keeps the last published artifact when hosted source-map preparation fails', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'compile-publication-'))
	const projectPath = path.join(root, 'project')
	const outputDir = path.join(root, 'out')
	const pool = createNodeCompilerPool()
	try {
		await mkdir(path.join(projectPath, 'pages/index'), { recursive: true })
		for (const [name, contents] of Object.entries({
			'app.js': 'App({})', 'app.json': '{"pages":["pages/index/index"]}',
			'project.config.json': '{"appid":"publication-test"}',
			'pages/index/index.js': 'Page({data:{value:"BEFORE"}})',
			'pages/index/index.wxml': '<view>{{value}}</view>',
			'pages/index/index.wxss': '', 'pages/index/index.json': '{}',
		})) await writeFile(path.join(projectPath, name), contents)
		await pool.build(outputDir, projectPath, true, { sourcemap: true })
		const published = path.join(outputDir, 'publication-test/main/logic.js')
		const before = await readFile(published, 'utf8')
		await writeFile(path.join(projectPath, 'pages/index/index.js'), 'Page({data:{value:"AFTER"}})')
		const replies: unknown[] = []
		const handler = createCompileWorkerHandler({
			loadCompiler: () => pool.build, chdir: () => {}, send: reply => { replies.push(reply) },
			normalizeHostedSourceMaps: async () => { throw new Error('map preparation failed') },
		})
		await handler({ cmd: 'build', projectPath, outputDir, options: { sourcemap: true, hostedSourcemaps: true } })
		expect(replies).toEqual([expect.objectContaining({ appInfo: null, error: expect.objectContaining({ message: 'map preparation failed' }) })])
		expect(await readFile(published, 'utf8')).toBe(before)
	} finally { await pool.dispose(); await rm(root, { recursive: true, force: true }) }
})
