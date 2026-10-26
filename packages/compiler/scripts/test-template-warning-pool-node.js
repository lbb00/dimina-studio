import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createNodeCompilerPool } from '../dist/pool.node.js'

async function writeFixture(root, template) {
  await writeFile(path.join(root, 'project.config.json'), JSON.stringify({ appid: 'template_warning_pool', projectname: 'template-warning-pool' }))
  await writeFile(path.join(root, 'app.js'), 'App({})')
  await writeFile(path.join(root, 'app.json'), JSON.stringify({ pages: ['pages/index/index'] }))
  await mkdir(path.join(root, 'pages/index'), { recursive: true })
  await writeFile(path.join(root, 'pages/index/index.js'), 'Page({})')
  await writeFile(path.join(root, 'pages/index/index.wxml'), template)
}

test('常驻 Node 池逐次返回模板 warning，不保留已修复结果', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'template-warning-pool-'))
  const output = (name) => path.join(root, `out-${name}`)
  const template = path.join(root, 'pages/index/index.wxml')
  const pool = createNodeCompilerPool()
  try {
    await writeFixture(root, '<view>\n<notatag/>\n</view>')
    const warned = await pool.build(output('warned'), root, true, {})
    assert.deepEqual(warned.diagnostics, [{
      source: template, line: 2, column: 1, endLine: 2, endColumn: 11,
      severity: 'warning', message: 'Unsupported or undeclared component: <notatag>',
    }])

    await writeFile(template, '<view/>')
    const clean = await pool.build(output('clean'), root, true, {})
    assert.deepEqual(clean.diagnostics, [])

    await writeFile(template, '<notatag/>')
    const reintroduced = await pool.build(output('reintroduced'), root, true, {})
    assert.equal(reintroduced.diagnostics.length, 1)
    assert.equal(reintroduced.diagnostics[0]?.severity, 'warning')
  } finally {
    await pool.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
