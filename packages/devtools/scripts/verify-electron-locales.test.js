import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const run = promisify(execFile)
const script = path.resolve(import.meta.dirname, 'verify-electron-locales.js')
const packageRoot = path.resolve(import.meta.dirname, '..')

async function withRelease(fixture) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dimina-electron-locales-'))
  try {
    await fixture(root)
    return root
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function writeLocales(root, platform, names) {
  const directory = platform === 'mac'
    ? path.join(root, 'mac-arm64', 'DevTools.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources')
    : path.join(root, `${platform}-unpacked`, 'locales')
  await mkdir(directory, { recursive: true })
  for (const name of names) {
    const target = path.join(directory, name)
    if (name.endsWith('.lproj')) await mkdir(target)
    else await writeFile(target, '')
  }
}

test('accepts nested macOS app locale resources', async () => {
  const root = await withRelease(async (release) => writeLocales(release, 'mac', ['en.lproj', 'zh_CN.lproj']))
  try {
    await run(process.execPath, [script, 'mac', root])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('accepts Linux locale resources', async () => {
  const root = await withRelease(async (release) => writeLocales(release, 'linux', ['en-US.pak', 'zh-CN.pak']))
  try {
    await run(process.execPath, [script, 'linux', root])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('accepts the package script platform argument', async () => {
  const root = await withRelease(async (release) => writeLocales(release, 'mac', ['en.lproj', 'zh_CN.lproj']))
  try {
    await run('pnpm', ['--dir', packageRoot, 'run', 'verify:electron-locales', 'mac', root])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects an additional macOS locale', async () => {
  const root = await withRelease(async (release) => writeLocales(release, 'mac', ['en.lproj', 'fr.lproj', 'zh_CN.lproj']))
  try {
    await assert.rejects(run(process.execPath, [script, 'mac', root]))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects an additional Linux locale', async () => {
  const root = await withRelease(async (release) => writeLocales(release, 'linux', ['en-US.pak', 'fr.pak', 'zh-CN.pak']))
  try {
    await assert.rejects(run(process.execPath, [script, 'linux', root]))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
