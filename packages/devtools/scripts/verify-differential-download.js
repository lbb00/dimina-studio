import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createServer, request } from 'node:http'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, copyFile, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
const run = promisify(execFile)
const evidenceDirectory = process.argv[2] ? path.resolve(process.argv[2]) : os.tmpdir()
await mkdir(evidenceDirectory, { recursive: true })
const root = await mkdtemp(path.join(evidenceDirectory, 'dimina-differential-'))
const require = createRequire(import.meta.url)
const { NsisUpdater } = require('electron-updater')
const engineRequire = createRequire(require.resolve('electron-updater'))
const yaml = engineRequire('js-yaml')
const builderRequire = createRequire(require.resolve('electron-builder'))
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'))
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor')
const { HttpExecutor } = engineRequire('builder-util-runtime')
// Only the HTTP transport is replaced; cache, diff planning, fallback and verification use the SDK.
class LocalHttpExecutor extends ElectronHttpExecutor {
  createRequest(options, callback) { return request({ ...options, agent: false }, callback) }
  addRedirectHandlers(...args) { return HttpExecutor.prototype.addRedirectHandlers.apply(this, args) }
}
const { appBuilderPath } = appBuilderRequire('app-builder-bin')
await mkdir(root, { recursive: true })
const hash = bytes => createHash('sha512').update(bytes).digest('base64')
const base = Buffer.alloc(8 * 1024 * 1024)
let random = 0x6d696e61
for (let i = 0; i < base.length; i++) { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; base[i] = random & 255 }
const fixtures = new Map()
for (let i = 1; i <= 5; i++) {
  const version = `1.0.${i}`
  const name = `client-${version}.exe`
  const bytes = Buffer.from(base)
  for (let j = 2; j <= i; j++) bytes.fill(j, j * 1024 * 1024, j * 1024 * 1024 + 8192)
  const file = path.join(root, name)
  await writeFile(file, bytes)
  await run(appBuilderPath, ['blockmap', '--input', file, '--output', `${file}.blockmap`])
  fixtures.set(version, { name, bytes, map: await readFile(`${file}.blockmap`), sha512: hash(bytes) })
}
await writeFile(path.join(root, 'app-update.yml'), 'updaterCacheDirName: local-differential-test\n')
let target = '1.0.1'
let scenario = 'cold'
const requests = []
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  const record = { scenario, pathname, range: req.headers.range ?? null, bytes: 0, status: 200 }
  requests.push(record)
  let body
  if (/latest.*\.yml$/.test(pathname)) {
    const f = fixtures.get(target)
    body = Buffer.from(yaml.dump({ version: target, files: [{ url: f.name, sha512: f.sha512, size: f.bytes.length }], path: f.name, sha512: f.sha512 }))
  } else {
    const map = pathname.endsWith('.blockmap')
    const f = [...fixtures.values()].find(value => pathname === `/${value.name}${map ? '.blockmap' : ''}`)
    if (!f || map && ['missing-map', 'corrupt-full'].includes(scenario)) { record.status = 404; res.writeHead(404); res.end(); return }
    body = map ? f.map : f.bytes
    if (req.headers.range) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range)
      if (!match) { res.writeHead(416); res.end(); return }
      const first = Number(match[1]), last = Number(match[2])
      body = Buffer.from(body.subarray(first, last + 1))
      if (scenario === 'corrupt-range') body[0] ^= 0xff
      record.status = 206
      res.setHeader('Content-Range', `bytes ${first}-${last}/${f.bytes.length}`)
    } else if (!map && scenario === 'corrupt-full') { body = Buffer.from(body); body[0] ^= 0xff }
  }
  record.bytes = body.length
  res.writeHead(record.status, { 'Content-Length': body.length, 'Accept-Ranges': 'bytes' })
  res.end(body)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}/`
const warnings = []
const onWarning = warning => warnings.push(String(warning))
process.on('warning', onWarning)
const logs = []
let installs = 0
function updater(version) {
  const adapter = {
    version, name: 'Local differential test', isPackaged: true,
    appUpdateConfigPath: path.join(root, 'app-update.yml'), userDataPath: path.join(root, 'user-data'), baseCachePath: path.join(root, 'cache'),
    whenReady: async () => {}, relaunch: () => { installs++; throw new Error('Unexpected relaunch') }, quit: () => { installs++; throw new Error('Unexpected quit') }, onQuit: () => { throw new Error('Automatic installation must stay disabled') },
  }
  const engine = new NsisUpdater(null, adapter)
  engine.httpExecutor = new LocalHttpExecutor(null)
  engine.autoDownload = false; engine.autoInstallOnAppQuit = false; engine.disableWebInstaller = true
  engine.setFeedURL({ provider: 'generic', url: origin, useMultipleRangeRequest: false })
  engine.logger = { info: m => logs.push(String(m)), warn: m => logs.push(String(m)), error: m => logs.push(String(m)), debug: () => {} }
  engine.on('error', error => logs.push(error.message))
  return engine
}
const results = []
try {
  for (const [mode, previous, next] of [['cold', '1.0.0', '1.0.1'], ['warm', '1.0.1', '1.0.2'], ['missing-map', '1.0.2', '1.0.3'], ['corrupt-range', '1.0.3', '1.0.4'], ['corrupt-full', '1.0.4', '1.0.5']]) {
    scenario = mode; target = next
    const engine = updater(previous)
    const check = await engine.checkForUpdates()
    assert.equal(check.isUpdateAvailable, true)
    let output, error
    try { [output] = await engine.downloadUpdate(check.cancellationToken) } catch (failure) { error = failure }
    const downloads = requests.filter(r => r.scenario === mode && r.pathname === `/${fixtures.get(next).name}`)
    const rangeBytes = downloads.filter(r => r.range).reduce((n, r) => n + r.bytes, 0)
    const fullBytes = downloads.filter(r => !r.range).reduce((n, r) => n + r.bytes, 0)
    if (mode === 'corrupt-full') {
      assert(error, 'A corrupt full download must fail')
      assert.match(String(error), /checksum|sha512/i)
    } else {
      assert.ifError(error)
      assert.equal(hash(await readFile(output)), fixtures.get(next).sha512)
      if (mode === 'warm') { assert(rangeBytes > 0); assert(rangeBytes < fixtures.get(next).bytes.length); assert.equal(fullBytes, 0) }
      if (mode === 'cold' || mode === 'missing-map') assert.equal(fullBytes, fixtures.get(next).bytes.length)
      if (mode === 'corrupt-range') { assert(rangeBytes > 0); assert.equal(fullBytes, fixtures.get(next).bytes.length) }
    }
    // NSIS seeds this baseline while installing; this fixture never executes an OS installer.
    if (output && !error) await copyFile(output, path.join(root, 'cache', 'local-differential-test', 'installer.exe'))
    results.push({ scenario: mode, from: previous, to: next, fullSize: fixtures.get(next).bytes.length, rangeBytes, fullBytes, verified: Boolean(output && !error), error: error ? String(error) : undefined })
  }
  assert.equal(installs, 0)
  assert.deepEqual(warnings, [])
  await writeFile(path.join(root, 'report.json'), JSON.stringify({ updaterVersion: require('electron-updater/package.json').version, fixture: 'binary download fixtures; no OS installer execution or signature validation', results, requests, installs }, null, 2))
  console.log(JSON.stringify({ root, results, installs }))
} finally {
  await new Promise(resolve => server.close(resolve))
  process.removeListener('warning', onWarning)
  await writeFile(path.join(root, 'engine.log'), logs.join('\n'))
}
