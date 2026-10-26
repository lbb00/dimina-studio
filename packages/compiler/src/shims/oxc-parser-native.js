import { parseSync as nativeParseSync } from 'oxc-parser'
import { parseSyncOrThrow } from '../compiler-diagnostics.js'

export function parseSync(filename, code, options) {
  return parseSyncOrThrow(nativeParseSync, filename, code, options)
}

export default { parseSync }
