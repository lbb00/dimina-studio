import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const packageRoot = path.resolve(import.meta.dirname, '..')
const [major, minor] = process.versions.node.split('.').map(Number)
assert.ok(
  major > 22 || (major === 22 && minor >= 12),
  `verify:asar-writer requires Node.js >=22.12.0; received ${process.versions.node}`,
)
const packageRequire = createRequire(path.join(packageRoot, 'package.json'))
const electronBuilderModule = packageRequire.resolve('electron-builder')
const electronBuilderRequire = createRequire(electronBuilderModule)
const builderModule = electronBuilderRequire.resolve('app-builder-lib')
const builderRequire = createRequire(builderModule)
const asarModule = builderRequire.resolve('@electron/asar')

function findPackageJson(modulePath) {
  let directory = path.dirname(modulePath)
  while (directory !== path.dirname(directory)) {
    const candidate = path.join(directory, 'package.json')
    if (existsSync(candidate) && JSON.parse(readFileSync(candidate, 'utf8')).name === '@electron/asar') {
      return candidate
    }
    directory = path.dirname(directory)
  }
  throw new Error(`Could not locate @electron/asar package.json from ${modulePath}`)
}

const asarPackageJson = findPackageJson(asarModule)
const asar = builderRequire('@electron/asar')
const { version } = JSON.parse(readFileSync(asarPackageJson, 'utf8'))

assert.equal(
  version,
  '4.3.1',
  `app-builder-lib must resolve @electron/asar 4.3.1, received ${version} from ${asarPackageJson}`,
)

const root = await mkdtemp(path.join(os.tmpdir(), 'dimina-asar-writer-'))
const archive = path.join(root, 'app.asar')
const previousUmask = process.umask(0o077)

function stream(contents) {
  return () => Readable.from([Buffer.from(contents)])
}

function file(pathname, contents, mode, unpacked = false) {
  return {
    type: 'file',
    path: pathname,
    unpacked,
    streamGenerator: stream(contents),
    stat: { mode, size: Buffer.byteLength(contents) },
  }
}

try {
  const duplicate = Buffer.concat([Buffer.alloc(4 * 1024 * 1024, 0x61), Buffer.from('tail')])
  const nativeContents = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
  const entries = [
    { type: 'directory', path: 'bin', unpacked: false },
    { type: 'directory', path: 'native', unpacked: true },
    file('first.txt', duplicate, 0o100644),
    file('second.txt', duplicate, 0o100644),
    file('bin/run', '#!/bin/sh\necho ready\n', 0o100755),
    file('native/addon.node', nativeContents, 0o100755, true),
    {
      type: 'link',
      path: 'alias.txt',
      unpacked: false,
      symlink: 'first.txt',
      streamGenerator: stream(''),
      stat: { mode: 0o120777, size: 0 },
    },
  ]

  await asar.createPackageFromStreams(archive, entries)
  const firstHeader = asar.getRawHeader(archive).header
  const files = firstHeader.files
  const duplicateIntegrity = files['first.txt'].integrity

  assert.equal(files['first.txt'].offset, files['second.txt'].offset, 'duplicate file contents must share an ASAR offset')
  assert.equal(duplicateIntegrity.algorithm, 'SHA256', 'archive entries must record their hash algorithm')
  assert.equal(duplicateIntegrity.hash, createHash('sha256').update(duplicate).digest('hex'), 'archive entry hash must cover stored bytes')
  assert.equal(duplicateIntegrity.blockSize, 4 * 1024 * 1024, 'archive entry integrity must retain the writer block size')
  assert.equal(duplicateIntegrity.blocks.length, 2, 'archive entry integrity must cover each block of a large file')
  assert.deepEqual(files['second.txt'].integrity, duplicateIntegrity, 'duplicate entries must retain the same integrity metadata')
  assert.equal(files.bin.files.run.executable, true, 'executable files must retain their executable flag')
  assert.equal(files['alias.txt'].link, 'first.txt', 'symbolic links must retain their target')
  assert.equal(files.native.files['addon.node'].unpacked, true, 'native files must remain outside app.asar')
  assert.deepEqual(
    await readFile(`${archive}.unpacked/native/addon.node`),
    nativeContents,
    'unpacked native file contents must be preserved',
  )

  await asar.createPackageFromStreams(archive, entries)
  const secondHeader = asar.getRawHeader(archive).header
  assert.equal(secondHeader.files['first.txt'].offset, secondHeader.files['second.txt'].offset, 'a second package run must retain deduplication')
  assert.deepEqual(await asar.extractFile(archive, 'first.txt'), duplicate, 'archive contents must remain readable after a second package run')
  assert.equal((await stat(`${archive}.unpacked/native/addon.node`)).mode & 0o777, 0o700, 'strict umask must apply while preserving owner execute permission')
} finally {
  process.umask(previousUmask)
  await rm(root, { recursive: true, force: true })
}

console.log(`Verified app-builder-lib uses @electron/asar ${version} with deduplication, integrity blocks, permissions, links, unpacked native files, and repeated packaging.`)
