import { parseSync as nativeParseSync } from 'oxc-parser'

globalThis.__oxcParseSync = nativeParseSync
const { parseSync } = await import('../src/shims/oxc-parser.js')

let failed = false
function check(condition, message) {
  if (condition) console.log(`✅ ${message}`)
  else {
    failed = true
    console.error(`❌ ${message}`)
  }
}

const valid = parseSync('/virtual/valid.ts', 'const 名称: string = "值"', {
  sourceType: 'module',
  lang: 'ts',
})
check(valid.errors.length === 0 && valid.program.type === 'Program',
  'the browser parser shim preserves valid TypeScript and Unicode ASTs')

try {
  parseSync('/virtual/broken.js', 'Page({\n  data: {},\n  broken: ;\n})', {
    sourceType: 'module',
    lang: 'js',
  })
  check(false, 'the browser parser shim rejects invalid JavaScript')
} catch (error) {
  check(error.code === 'compiler-stage-error', 'the browser parser shim uses the compiler error code')
  check(error.diagnostics?.[0]?.source === '/virtual/broken.js'
    && error.diagnostics[0]?.line === 3
    && error.diagnostics[0]?.column === 11,
  'the browser parser shim preserves original source positions')
}

delete globalThis.__oxcParseSync
if (failed) process.exitCode = 1
