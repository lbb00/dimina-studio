import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
const run = promisify(execFile), script = path.resolve(import.meta.dirname, 'verify-release-artifacts.js')
async function fixture(files) { const dir = await mkdtemp(path.join(os.tmpdir(), 'dimina-release-')); for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), body); return dir }
test('accepts present metadata references', async () => { const dir = await fixture({'a.zip':'x','latest-mac.yml':'path: a.zip\n','latest.yml':'path: a.zip\n','latest-linux.yml':'path: a.zip\n'}); try { await run(process.execPath,[script,dir]) } finally { await rm(dir,{recursive:true,force:true}) } })
test('rejects missing metadata and referenced artifacts', async () => { const dir = await fixture({'latest-mac.yml':'path: missing.zip\n','latest.yml':'path: missing.zip\n'}); try { await assert.rejects(run(process.execPath,[script,dir])) } finally { await rm(dir,{recursive:true,force:true}) } })
