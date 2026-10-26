import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

const platform = process.argv[2]
assert.ok(['linux', 'mac', 'win'].includes(platform), 'usage: verify:electron-locales <linux|mac|win> [output-directory]')

const packageRoot = path.resolve(import.meta.dirname, '..')
const releaseRoot = process.argv[3] ? path.resolve(process.argv[3]) : path.join(packageRoot, 'release')

async function findMacApplication(directory) {
  const matches = []
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name)
      if (!entry.isDirectory()) continue
      if (entry.name.endsWith('.app')) {
        matches.push(child)
      } else {
        await visit(child)
      }
    }
  }
  await visit(directory)
  assert.equal(matches.length, 1, `expected exactly one macOS app under ${directory}, found ${matches.join(', ') || 'none'}`)
  return matches[0]
}

const localesDirectory = platform === 'mac'
  ? path.join(await findMacApplication(releaseRoot), 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources')
  : path.join(releaseRoot, `${platform}-unpacked`, 'locales')

const entries = await readdir(localesDirectory, { withFileTypes: true })
const actual = platform === 'mac'
  ? entries.filter((entry) => entry.isDirectory() && entry.name.endsWith('.lproj')).map((entry) => entry.name).sort()
  : entries.filter((entry) => entry.isFile() && entry.name.endsWith('.pak')).map((entry) => entry.name).sort()
const expected = platform === 'mac' ? ['en.lproj', 'zh_CN.lproj'] : ['en-US.pak', 'zh-CN.pak']

assert.deepEqual(actual, expected, `unexpected Electron locale resources in ${localesDirectory}`)
console.log(`Verified ${platform} Electron locale resources: ${actual.join(', ')}`)
