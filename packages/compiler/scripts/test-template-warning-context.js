import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Volume, createFsFromVolume } from 'memfs'
import { compileMiniApp, resetCompilerState } from '../dist/compile-core.node.js'

async function compile(files) {
  resetCompilerState()
  return compileMiniApp({
    fs: createFsFromVolume(Volume.fromJSON(files, '/work')),
    workPath: '/work',
  })
}

const component = {
  'components/card.js': 'Component({})',
  'components/card.json': JSON.stringify({ component: true }),
  'components/card.wxml': '<view/>',
}

test('嵌套 include 使用发起页面的组件登记', async () => {
  const result = await compile({
    'app.js': 'App({})',
    'app.json': JSON.stringify({ pages: ['pages/index'] }),
    'pages/index.js': 'Page({})',
    'pages/index.json': JSON.stringify({ usingComponents: { card: '/components/card' } }),
    'pages/index.wxml': '<include src="../shared/outer.wxml"/>',
    'shared/outer.wxml': '<include src="./inner.wxml"/>',
    'shared/inner.wxml': '<card/>',
    ...component,
  })
  assert.deepEqual(result.diagnostics, [])
})

test('多个页面共用模板时仍按各自登记判断并合并同一警告', async () => {
  const files = {
    'app.js': 'App({})',
    'app.json': JSON.stringify({ pages: ['pages/a', 'pages/b', 'pages/c'] }),
    'shared/part.wxml': '<card/>',
    ...component,
  }
  for (const name of ['a', 'b', 'c']) {
    files[`pages/${name}.js`] = 'Page({})'
    files[`pages/${name}.json`] = JSON.stringify(name === 'a' ? { usingComponents: { card: '/components/card' } } : {})
    files[`pages/${name}.wxml`] = '<include src="../shared/part.wxml"/>'
  }
  const result = await compile(files)
  assert.deepEqual(result.diagnostics, [{
    source: '/work/shared/part.wxml', line: 1, column: 1,
    endLine: 1, endColumn: 8, severity: 'warning',
    message: 'Unsupported or undeclared component: <card>',
  }])
})

for (const [name, template, line, column] of [
  ['同一行的中文与非 BMP 字符', '<view>😀中<notatag/></view>', 1, 10],
  ['CRLF 换行后的中文与非 BMP 字符', '<view>\r\n😀中<notatag/>\r\n</view>', 2, 4],
]) {
  test(`${name}之后的警告范围按 UTF-16 计数`, async () => {
    const result = await compile({
      'app.js': 'App({})',
      'app.json': JSON.stringify({ pages: ['pages/index'] }),
      'pages/index.js': 'Page({})',
      'pages/index.wxml': template,
    })
    assert.deepEqual(result.diagnostics, [{
      source: '/work/pages/index.wxml', line, column,
      endLine: line, endColumn: column + '<notatag/>'.length,
      severity: 'warning', message: 'Unsupported or undeclared component: <notatag>',
    }])
  })
}
