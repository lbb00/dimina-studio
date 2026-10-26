import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse, stringify } from 'yaml'
const [directory, ...inputs] = process.argv.slice(2)
assert.ok(directory && inputs.length === 2, 'expected arm64 and x64 metadata files')
const docs = await Promise.all(inputs.map(async (file) => parse(await readFile(file, 'utf8'))))
assert.ok(docs.every((doc) => doc.version === docs[0].version), 'mac metadata versions must match')
const files = docs.flatMap((doc) => doc.files || [])
assert.ok(files.length >= 2, 'mac metadata must contain both architecture files')
for (const file of files) { assert.ok(file.url && file.sha512 && file.size, 'metadata files require url, sha512 and size'); assert.ok(existsSync(path.join(directory, file.url)), `missing artifact ${file.url}`); assert.ok(existsSync(path.join(directory, `${file.url}.blockmap`)), `missing blockmap for ${file.url}`) }
assert.ok(files.some((file) => /arm64/.test(file.url)), 'missing arm64 mac artifact')
assert.ok(files.some((file) => /x64/.test(file.url)), 'missing x64 mac artifact')
const merged = { ...docs[0], files: [...new Map(files.map((file) => [file.url, file])).values()] }
await writeFile(path.join(directory, 'latest-mac.yml'), stringify(merged))
