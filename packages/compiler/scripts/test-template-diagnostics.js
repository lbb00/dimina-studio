import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Volume, createFsFromVolume } from 'memfs'
import { compileMiniApp, resetCompilerState } from '../dist/compile-core.node.js'

const base = {
  'app.js': 'App({})',
  'app.json': JSON.stringify({ pages: ['pages/index'] }),
  'pages/index.js': 'Page({data:{count:1}})',
  'pages/index.wxml': '<view>{{count}}</view>',
}
const compile = (changes, options = {}) => {
  resetCompilerState()
  return compileMiniApp({
  fs: createFsFromVolume(Volume.fromJSON(Object.fromEntries(Object.entries({ ...base, ...changes }).filter(([, content]) => content !== null)), '/work')),
  workPath: '/work', options,
  })
}

for (const [name, content, line] of [
  ['尾部损坏标记', '<view>hello</view>\n<<<', 2],
  ['缺少结束标签', '<view>hello', 1],
  ['不完整插值', '<view>{{count +}}</view>', 1],
  ['不完整条件属性', '<view\n wx:if="{{count +}}">x</view>', 2],
  ['不完整普通属性', '<view\n class="{{count +}}">x</view>', 2],
]) {
  test(`${name}返回原始模板位置`, async () => {
    await assert.rejects(compile({ 'pages/index.wxml': content }), (error) => {
      assert.equal(error.code, 'compiler-stage-error')
      assert.equal(error.diagnostics[0].source, '/work/pages/index.wxml')
      assert.equal(error.diagnostics[0].line, line)
      assert.ok(error.diagnostics[0].column > 0)
      return true
    })
  })
}

test('自定义模板后缀使用同一诊断入口', async () => {
  await assert.rejects(compile({ 'pages/index.wxml': null, 'pages/index.altml': '<view>\n<<<' },
    { fileTypes: { template: ['altml'] } }), (error) => {
    assert.equal(error.diagnostics[0].source, '/work/pages/index.altml')
    return true
  })
})

test('include的损坏模板保留被引入文件位置', async () => {
  await assert.rejects(compile({ 'pages/index.wxml': '<include src="./part.wxml"/>',
    'pages/part.wxml': '<view>{{count +}}</view>' }), (error) => {
    assert.equal(error.diagnostics[0].source, '/work/pages/part.wxml')
    return true
  })
})

test('合法方言、自定义组件和脚本内的插值字符串仍可编译', async () => {
  const result = await compile({ 'pages/index.wxml': '<wxs module="m">var text="{{a+}}"; module.exports={text:text};</wxs><view wx:if="{{count}}"><custom-card/><input/><text>{{m.text}}</text></view>' })
  assert.ok(Object.keys(result.files).length > 0)
})

test('未被页面引用的损坏模板不影响当前编译', async () => {
  const result = await compile({ 'unused.wxml': '<view>\n<<<' })
  assert.ok(Object.keys(result.files).length > 0)
})

test('属性实体不会误判为坏表达式', async () => {
  const result = await compile({ 'pages/index.wxml': '<view class="{{count &gt; 0 ? \'active\' : \'empty\'}}">x</view>' })
  assert.ok(Object.keys(result.files).length > 0)
})

test('修正模板后下一次编译恢复', async () => {
  await assert.rejects(compile({ 'pages/index.wxml': '<view>{{count +}}</view>' }))
  const result = await compile({ 'pages/index.wxml': '<view>{{count + 1}}</view>' })
  assert.ok(Object.keys(result.files).length > 0)
})

test('未知组件作为成功编译的结构化 warning 返回，并能在修正后清除再引入', async () => {
  const warned = await compile({ 'pages/index.wxml': '<view>\n<notatag/>\n</view>' })
  assert.deepEqual(warned.diagnostics, [{
    source: '/work/pages/index.wxml', line: 2, column: 1, endLine: 2, endColumn: 11,
    severity: 'warning', message: 'Unsupported or undeclared component: <notatag>',
  }])
  const clean = await compile({ 'pages/index.wxml': '<view/>' })
  assert.deepEqual(clean.diagnostics, [])
  const reintroduced = await compile({ 'pages/index.wxml': '<notatag/>' })
  assert.equal(reintroduced.diagnostics?.[0]?.severity, 'warning')
})

test('声明组件、HTML、内置标签和 view script 标签不产生未知组件 warning', async () => {
  const result = await compile({
    'app.json': JSON.stringify({ pages: ['pages/index'], usingComponents: { card: '/components/card' } }),
    'pages/index.wxml': '<view><card/><div/><input/><wxs module="m">module.exports={}</wxs></view>',
    'components/card.js': 'Component({})', 'components/card.json': '{}', 'components/card.wxml': '<view/>',
  })
  assert.deepEqual(result.diagnostics, [])
})
