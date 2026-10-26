# @dimina-studio/compiler

这个包用于编译 Dimina 小程序，可以在 Node.js 或浏览器中运行。使用者需要传入读取项目文件的方法。本包不会自行读取电脑上的文件。

## 安装

```bash
pnpm add @dimina-studio/compiler
```

在浏览器中使用时，还要在你的项目中直接安装 `esbuild-wasm`、`oxc-parser` 和 `@oxc-parser/binding-wasm32-wasi`。编译器需要这些包解析 JavaScript，并加载适合浏览器使用的 WebAssembly 二进制文件。

## Node.js 快速开始

`compileMiniApp()` 接收一个实现同步 Node.js `fs` 常用方法的对象。下面以 `memfs` 为例；先把完整项目写入 `/project`，再读取返回的产物。

```ts
import { fs } from 'memfs'
import { compileMiniApp } from '@dimina-studio/compiler'

fs.mkdirSync('/project/pages/home', { recursive: true })
fs.writeFileSync('/project/app.json', '{"pages":["pages/home/home"]}')
fs.writeFileSync('/project/pages/home/home.wxml', '<view>Hello</view>')

const result = await compileMiniApp({ fs, workPath: '/project' })
console.log(result.appId, result.files)
```

同一个 JavaScript 执行环境一次只运行一个编译任务。要同时编译多个项目，请使用独立进程或后台线程（Worker）。`options.fileTypes` 可以增加模板、样式和视图脚本的文件扩展名，例如 `{ options: { fileTypes: { template: ['altml'], style: ['altss'], viewScript: ['alts'] } } }`。

## 浏览器接入

浏览器主线程使用 `@dimina-studio/compiler/pool`。它把三个编译阶段放到后台线程（Worker），避免编译阻塞页面。你还要提供 `toolchainSetupURL`。它是一个 JavaScript 模块地址，后台线程会通过这个地址加载 WebAssembly 编译工具。

```ts
import { createCompilerPool } from '@dimina-studio/compiler/pool'

const files = {
  'app.json': '{"pages":["pages/home/home"]}',
  'pages/home/home.wxml': '<view>Hello</view>',
}

const pool = createCompilerPool({
  createWorker: () => new Worker(new URL('@dimina-studio/compiler/stage-worker', import.meta.url), { type: 'module' }),
  toolchainSetupURL: new URL('./toolchain-setup.js', import.meta.url).href,
  onLog: entry => console.warn(entry.stage, entry.message),
})

const result = await pool.compile({ files, workPath: '/project' })
await pool.dispose()
```

`toolchain-setup.js` 由你的应用打包或提供。它必须安装 `oxc-parser` 与 `esbuild-wasm`，并确保后台线程能读取相关的 JavaScript 和 WebAssembly 文件：

```ts
import { installEsbuildFromURL, installOxc } from '@dimina-studio/compiler/toolchain'

installOxc(await import('oxc-parser'))
await installEsbuildFromURL('/assets/esbuild-browser.mjs', '/assets/esbuild.wasm')
```

页面和后台线程必须启用浏览器的跨来源隔离。服务器需要返回 COOP `same-origin` 和 COEP `require-corp` 响应头，否则浏览器不会提供编译所需的共享内存。编译工具或静态文件加载失败时，`compile()` 会抛出带错误码的异常；`onLog` 会收到编译日志。若只需在浏览器中编译一次，可从 `@dimina-studio/compiler/browser` 导入 `compileMiniApp`，但仍需先安装同一套工具。

## 其他入口

- `@dimina-studio/compiler/pool-node`：复用一组 Node.js 后台线程，适合在文件变化后反复编译。
- `@dimina-studio/compiler/file-types`：内置扩展名、保留扩展名和 `resolveFileTypes()`。
- `@dimina-studio/compiler/browser-assets`：浏览器构建需要托管的静态资源清单。

## 仓库内开发

```bash
pnpm --filter @dimina-studio/compiler build
pnpm --filter @dimina-studio/compiler check-types
pnpm --filter @dimina-studio/compiler test
```

## License

[MIT](../../LICENSE)
