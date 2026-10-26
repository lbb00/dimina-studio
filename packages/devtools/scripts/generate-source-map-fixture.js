import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createNodeCompilerPool } from '@dimina-studio/compiler/pool-node'

const appId = 'source_map_fixture'
const root = await mkdtemp(path.join(os.tmpdir(), 'dimina-source-map-路径 '))
const projectRoot = path.join(root, '小程序 project')
const outputRoot = path.join(root, 'out')
await Promise.all([
  mkdir(path.join(projectRoot, 'pages/index'), { recursive: true }),
  mkdir(path.join(projectRoot, 'packages/feature/pages/detail'), { recursive: true }),
])
await Promise.all([
  writeFile(path.join(projectRoot, 'app.js'), 'App({})'),
  writeFile(path.join(projectRoot, 'app.json'), JSON.stringify({
    pages: ['pages/index/index'],
    subpackages: [{ root: 'packages/feature', pages: ['pages/detail/index'] }],
  })),
  writeFile(path.join(projectRoot, 'project.config.json'), JSON.stringify({ appid: appId })),
  writeFile(path.join(projectRoot, 'pages/index/index.json'), '{}'),
  writeFile(path.join(projectRoot, 'pages/index/index.wxml'), '<view>{{count}}</view>'),
  writeFile(path.join(projectRoot, 'pages/index/index.ts'), 'const count: number = 1\nPage({ data: { count } })\n'),
  writeFile(path.join(projectRoot, 'packages/feature/pages/detail/index.json'), '{}'),
  writeFile(path.join(projectRoot, 'packages/feature/pages/detail/index.wxml'), '<view>detail</view>'),
  writeFile(path.join(projectRoot, 'packages/feature/pages/detail/index.js'), 'Page({ data: { detail: true } })\n'),
])

const pool = createNodeCompilerPool()
try {
  await pool.build(outputRoot, projectRoot, true, { sourcemap: true })
} finally {
  await pool.dispose()
}

console.log(JSON.stringify({
  root,
  projectRoot,
  maps: {
    main: path.join(outputRoot, appId, 'main/logic.js.map'),
    subpackage: path.join(outputRoot, appId, 'sub_packages/feature/logic.js.map'),
  },
  sourcePaths: {
    main: path.join(projectRoot, 'pages/index/index.ts'),
    subpackage: path.join(projectRoot, 'packages/feature/pages/detail/index.js'),
  },
  appId,
}))
