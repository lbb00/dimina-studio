// setupCompile copies project .wasm/.pag/.mp4 files into the product and records
// them on the dependency graph. main-package files land under main/. A directory
// in npmScanExclude is not an input: wasm inside it is not copied and not
// recorded, and a miniprogram_npm inside it is not copied either. A
// miniprogram_npm at the project root still is.
//
// compile-core.node.js aliases node:fs, so the memfs case drives the injected
// backend. pool.node.js uses native fs; its publish directory is the
// npmScanExclude root when that directory sits inside the project.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setupCompile, collectOutputs } from '../dist/compile-core.node.js'
import { seedMemfs } from '../src/seed-memfs.js'

const WP = '/work'
const WASM = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0])
const MP4 = Uint8Array.from([0, 0, 0, 8, 102, 116, 121, 112])
const STALE_WASM = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 255])
const PAG = 'PAG fixture'

const PROJECT = {
  'project.config.json': JSON.stringify({ appid: 'binaryassets' }),
  'app.js': 'App({})',
  'app.json': JSON.stringify({ pages: ['pages/index'] }),
  'pages/index.js': 'Page({})',
  'pages/index.wxml': '<view>hi</view>',
  'pages/index.json': '{}',
  'utils/mod.wasm': WASM,
  'assets/clip.pag': PAG,
  'media/clip.mp4': MP4,
  'miniprogram_npm/foo/index.js': 'module.exports = 1',
  'miniprogram_npm/foo/package.json': JSON.stringify({ name: 'foo', version: '1.0.0' }),
  'published/utils/stale.wasm': STALE_WASM,
  'published/miniprogram_npm/junk/index.js': 'module.exports = 2',
  'published/miniprogram_npm/junk/package.json': JSON.stringify({ name: 'junk', version: '1.0.0' }),
}

function sameBytes(a, b) {
  return !!a && !!b && a.length === b.length && [...a].every((byte, i) => byte === b[i])
}

function edgeFor(graph, suffix) {
  return (graph?.fileEdges || []).find((edge) => edge.file.endsWith(suffix))
}

let pass = 0
let fail = 0
const check = async (label, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${label}`)
    pass++
  } catch (e) {
    console.error(`  ❌ ${label}\n       ${e.message}`)
    fail++
  }
}

await check('memfs setupCompile copies main-package wasm, pag, and mp4 and records them', async () => {
  const fsImpl = seedMemfs(PROJECT, WP)
  const ctx = await setupCompile({
    fs: fsImpl,
    workPath: WP,
    npmScanExclude: [`${WP}/published`],
  })
  const out = collectOutputs({ fs: fsImpl, targetPath: ctx.targetPath })
  const keys = Object.keys(out).sort()
  assert.ok(sameBytes(out['main/utils/mod.wasm'], WASM), `main/utils/mod.wasm missing or changed; products: ${keys.join(', ')}`)
  assert.equal(out['main/assets/clip.pag'], PAG, `main/assets/clip.pag missing; products: ${keys.join(', ')}`)
  assert.ok(sameBytes(out['main/media/clip.mp4'], MP4), `main/media/clip.mp4 missing or changed; products: ${keys.join(', ')}`)

  const graph = ctx.storeInfo.dependencyGraph
  for (const suffix of ['/utils/mod.wasm', '/assets/clip.pag', '/media/clip.mp4']) {
    const edge = edgeFor(graph, suffix)
    assert.ok(edge, `dependency graph has no file edge for ${suffix}; edges: ${JSON.stringify(graph?.fileEdges || [])}`)
    assert.equal(edge.owner, 'app', `${suffix} owner`)
    assert.ok(edge.kinds.includes('config'), `${suffix} kinds ${edge.kinds.join(',')}`)
  }
  const leakedEdge = (graph?.fileEdges || []).find((edge) => edge.file.endsWith('/stale.wasm') || edge.file.includes('/published/'))
  assert.equal(leakedEdge, undefined, `excluded publish file was recorded: ${JSON.stringify(leakedEdge)}`)
})

await check('memfs setupCompile does not copy wasm or npm from an excluded publish directory', async () => {
  const fsImpl = seedMemfs(PROJECT, WP)
  const ctx = await setupCompile({
    fs: fsImpl,
    workPath: WP,
    npmScanExclude: [`${WP}/published`],
  })
  const out = collectOutputs({ fs: fsImpl, targetPath: ctx.targetPath })
  const keys = Object.keys(out)
  const leaked = keys.filter((key) => key.includes('stale.wasm') || key.includes('published/') || key.includes('/junk/') || key.startsWith('junk/'))
  assert.deepEqual(leaked, [], `excluded publish tree reached the product: ${leaked.join(', ')}`)
  assert.ok(
    keys.some((key) => key.startsWith('miniprogram_npm/foo/')),
    `root miniprogram_npm was dropped; products: ${keys.join(', ')}`,
  )
})

function writeProjectFile(root, relPath, content) {
  const full = path.join(root, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

function listFiles(root) {
  const out = []
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const next = rel ? `${rel}/${name}` : name
      if (fs.statSync(full).isDirectory()) walk(full, next)
      else out.push(next)
    }
  }
  walk(root, '')
  return out.sort()
}

await check('node disk publish directory inside the project is not a binary or npm input', async () => {
  const { createNodeCompilerPool } = await import('../dist/pool.node.js')
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcc-binary-assets-'))
  const pool = createNodeCompilerPool()
  const outputDir = path.join(tmpRoot, 'dist')
  try {
    for (const [rel, content] of Object.entries(PROJECT)) {
      if (rel.startsWith('published/')) continue
      writeProjectFile(tmpRoot, rel, content)
    }
    writeProjectFile(outputDir, 'old-app/utils/stale.wasm', STALE_WASM)
    writeProjectFile(outputDir, 'old-app/miniprogram_npm/junk/index.js', 'module.exports = 2')
    writeProjectFile(outputDir, 'old-app/miniprogram_npm/junk/package.json', JSON.stringify({ name: 'junk', version: '1.0.0' }))

    const info = await pool.build(outputDir, tmpRoot, true, {})
    const product = path.join(outputDir, info.appId)
    const names = listFiles(product)
    assert.ok(sameBytes(fs.readFileSync(path.join(product, 'main/utils/mod.wasm')), WASM), `main/utils/mod.wasm missing; product: ${names.join(', ')}`)
    assert.equal(fs.readFileSync(path.join(product, 'main/assets/clip.pag'), 'utf8'), PAG)
    assert.ok(sameBytes(fs.readFileSync(path.join(product, 'main/media/clip.mp4')), MP4), 'main/media/clip.mp4 missing or changed')
    const leaked = names.filter((name) => name.includes('stale.wasm') || name.includes('/junk/') || name.startsWith('junk/'))
    assert.deepEqual(leaked, [], `excluded publish tree reached the product: ${leaked.join(', ')}`)
    assert.ok(names.some((name) => name.startsWith('miniprogram_npm/foo/')), `root miniprogram_npm was dropped; product: ${names.join(', ')}`)

    const info2 = await pool.build(outputDir, tmpRoot, true, {})
    const binaries = listFiles(path.join(outputDir, info2.appId)).filter((name) => /\.(?:wasm|pag|mp4)$/.test(name))
    assert.deepEqual(binaries, [
      'main/assets/clip.pag',
      'main/media/clip.mp4',
      'main/utils/mod.wasm',
    ])
  } finally {
    await pool.dispose()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

await check('a second build into the project root does not nest appId binaries', async () => {
  const { createNodeCompilerPool } = await import('../dist/pool.node.js')
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcc-binary-root-'))
  const pool = createNodeCompilerPool()
  try {
    for (const [rel, content] of Object.entries(PROJECT)) {
      if (rel.startsWith('published/')) continue
      writeProjectFile(tmpRoot, rel, content)
    }
    const info = await pool.build(tmpRoot, tmpRoot, true, {})
    const product = path.join(tmpRoot, info.appId)
    await pool.build(tmpRoot, tmpRoot, true, {})
    const binaries = listFiles(product).filter((name) => /\.(?:wasm|pag|mp4)$/.test(name))
    assert.deepEqual(binaries, [
      'main/assets/clip.pag',
      'main/media/clip.mp4',
      'main/utils/mod.wasm',
    ])
    assert.ok(
      listFiles(product).some((name) => name.startsWith('miniprogram_npm/foo/')),
      'root miniprogram_npm was skipped because the project itself was the exclude',
    )
  } finally {
    await pool.dispose()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

console.log(`\n${'─'.repeat(56)}\nResults: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
console.log('Binary runtime asset assertions passed.')
