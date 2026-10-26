import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Volume, createFsFromVolume } from 'memfs'
import { compileMiniApp, resetCompilerState } from '../dist/compile-core.node.js'

const compile = async (template) => {
  resetCompilerState()
  return compileMiniApp({
    fs: createFsFromVolume(Volume.fromJSON({
      'app.js': 'App({})',
      'app.json': JSON.stringify({ pages: ['pages/index'] }),
      'pages/index.js': 'Page({data:{a:1}})',
      'pages/index.wxml': template,
    }, '/work')),
    workPath: '/work',
  })
}

for (const tag of ['input', 'img']) {
  test(`${tag}的显式结束标签按 XML 模板合法编译`, async () => {
    const result = await compile(`<${tag} value="{{a}}"></${tag}>`)
    assert.deepEqual(result.diagnostics, [])
    assert.ok(Object.keys(result.files).length > 0)
  })

  test(`${tag}的自闭合形式按 XML 模板合法编译`, async () => {
    const result = await compile(`<${tag} value="{{a}}"/>`)
    assert.deepEqual(result.diagnostics, [])
  })

  test(`${tag}缺少结束标签返回原文件错误`, async () => {
    await assert.rejects(compile(`<${tag} value="{{a}}">`), (error) => {
      assert.equal(error.code, 'compiler-stage-error')
      assert.equal(error.diagnostics[0].source, '/work/pages/index.wxml')
      assert.equal(error.diagnostics[0].line, 1)
      return true
    })
  })
}
