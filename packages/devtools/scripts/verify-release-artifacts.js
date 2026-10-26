import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const directory = path.resolve(process.argv[2] || '.')
const metadata = ['latest-mac.yml', 'latest.yml', 'latest-linux.yml']
for (const name of metadata) assert.ok(existsSync(path.join(directory, name)), `missing update metadata: ${name}`)
for (const name of metadata) {
  const text = readFileSync(path.join(directory, name), 'utf8')
  for (const file of [...text.matchAll(/(?:path|url):\s*['"]?([^'"\s]+)/g)].map((match) => match[1])) {
    assert.ok(existsSync(path.join(directory, file)), `${name} references missing artifact: ${file}`)
  }
}
console.log(`Verified release artifact metadata in ${directory}`)
