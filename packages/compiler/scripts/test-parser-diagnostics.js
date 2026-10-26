import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseSync } from 'oxc-parser'
import { createNodeCompilerPool } from '../dist/pool.node.js'
import { isCompilerDiagnosticsError, parseSyncOrThrow } from '../src/compiler-diagnostics.js'

const root = await mkdtemp(path.join(os.tmpdir(), 'dimina-parser-diagnostics-'))
const pool = createNodeCompilerPool()
let failed = false

function check(condition, message) {
  if (condition) console.log(`✅ ${message}`)
  else {
    failed = true
    console.error(`❌ ${message}`)
  }
}

async function seedProject(dir, filename, source) {
  await mkdir(path.join(dir, 'pages/index'), { recursive: true })
  await Promise.all([
    writeFile(path.join(dir, 'app.js'), 'App({})'),
    writeFile(path.join(dir, 'app.json'), JSON.stringify({ pages: ['pages/index/index'] })),
    writeFile(path.join(dir, 'project.config.json'), JSON.stringify({ appid: 'parser_diagnostics' })),
    writeFile(path.join(dir, 'pages/index/index.json'), '{}'),
    writeFile(path.join(dir, 'pages/index/index.wxml'), '<view />'),
    writeFile(path.join(dir, 'pages/index', filename), source),
  ])
}

async function expectCompile(name, filename, source, sourcemap, expected) {
  const project = path.join(root, `${name}-${sourcemap ? 'map' : 'plain'}`)
  const output = path.join(root, `${name}-${sourcemap ? 'map' : 'plain'}-out`)
  await seedProject(project, filename, source)
  try {
    await pool.build(output, project, true, { sourcemap })
    check(expected === 'success', `${name} map=${sourcemap} succeeds only for valid source`)
  } catch (error) {
    check(expected === 'failure', `${name} map=${sourcemap} rejects invalid source`)
    if (expected === 'failure') {
      check(error.code === 'compiler-stage-error', `${name} map=${sourcemap} keeps the compiler error code`)
      check(error.message.includes(`${filename}:3:11`), `${name} map=${sourcemap} reports the original file line and column`)
    }
  }
  try {
    await readFile(path.join(output, 'parser_diagnostics/main/logic.js'), 'utf8')
    check(expected === 'success', expected === 'success'
      ? `${name} map=${sourcemap} publishes logic output for valid source`
      : `${name} map=${sourcemap} does not publish logic output after a parser error`)
  } catch (error) {
    check(expected === 'failure' && error.code === 'ENOENT', expected === 'failure'
      ? `${name} map=${sourcemap} does not publish logic output after a parser error`
      : `${name} map=${sourcemap} publishes logic output for valid source`)
  }
}

try {
  const unicodeSource = 'const 你 = ;'
  try {
    parseSyncOrThrow(parseSync, '/virtual/unicode.js', unicodeSource, { sourceType: 'module', lang: 'js' })
    check(false, 'UTF-16 parser offsets reject invalid Unicode source')
  } catch (error) {
    check(isCompilerDiagnosticsError(error), 'UTF-16 parser errors use CompilerDiagnosticsError')
    check(error.diagnostics[0]?.line === 1 && error.diagnostics[0]?.column === 11,
      'UTF-16 parser offsets keep the Unicode source column')
  }

  const validCases = [
    ['valid-js', 'index.js', 'Page({ data: { count: 1 } })'],
    ['valid-ts', 'index.ts', 'const count: number = 1\nPage({ data: { count } })'],
    ['valid-unicode', 'index.js', 'const 名称 = "值"\nPage({ data: { 名称 } })'],
  ]
  for (const [name, filename, source] of validCases) {
    await expectCompile(name, filename, source, false, 'success')
    await expectCompile(name, filename, source, true, 'success')
  }

  const invalid = 'Page({\n  data: {},\n  broken: ;\n})'
  await expectCompile('invalid-js', 'index.js', invalid, false, 'failure')
  await expectCompile('invalid-js', 'index.js', invalid, true, 'failure')
} finally {
  await pool.dispose()
  await rm(root, { recursive: true, force: true })
}

if (failed) process.exitCode = 1
