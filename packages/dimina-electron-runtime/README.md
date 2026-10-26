# @dimina-studio/electron-runtime

这个包让现有 Electron 应用可以显示和运行 Dimina 小程序。你的应用仍负责 Electron 的 `app`、窗口、布局和退出。本包负责启动小程序、显示页面和转发消息。

## 安装

```bash
pnpm add @dimina-studio/electron-runtime @dimina-studio/devkit electron@^43.2.0
```

需要 Node.js 20 或更高版本。项目必须自行安装 Electron `^43.2.0`，本包不会替你安装。只有使用 `@dimina-studio/electron-runtime/simulator-ui` 时才需要 React 18 或更高版本。下面使用 devkit 编译项目，你也可以传入自己的编译方法。

## 快速开始

```ts
import { app, BrowserWindow } from 'electron'
import {
  createElectronRuntime,
  registerElectronRuntimeSchemes,
} from '@dimina-studio/electron-runtime'
import { openProject } from '@dimina-studio/devkit'

registerElectronRuntimeSchemes()

async function start() {
  await app.whenReady()
  const window = new BrowserWindow()
  const runtime = await createElectronRuntime({
    hostWindow: window,
    adapter: { openProject },
  })
  const session = await runtime.openProject({ projectPath: '/absolute/miniapp' })
  window.contentView.addChildView(session.view)
  session.setBounds({ x: 0, y: 0, width: 390, height: 844 })
  await session.ready
}

start().catch((error) => {
  console.error(error)
  app.quit()
})
```

`registerElectronRuntimeSchemes()` 必须在 `app` 就绪前调用。一个 Electron 进程只能创建一个运行环境。移除项目视图前调用 `session.dispose()`；应用退出时调用 `runtime.dispose()`。不要在主进程文件的最外层 `await app.whenReady()`，否则 Electron 无法完成启动。

## 打包应用

本包的 `dist/` 中包含页面代码、预加载脚本（`preload`）和 HTML 文件。如果打包工具把本包代码合进了主程序，请把完整的 `dist/` 复制到应用资源目录，并通过 `assetsRoot` 传入绝对路径：

```ts
const runtime = await createElectronRuntime({
  hostWindow: window,
  adapter: { openProject },
  assetsRoot: path.join(process.resourcesPath, 'dimina-electron-runtime'),
})
```

该目录必须保留原有结构。`simulator/` 是模拟器界面，`preload/` 是预加载脚本，`render-host/` 显示小程序页面，`service-host/` 运行小程序逻辑，`native-host/` 连接原生端。

## 公开入口

主入口提供创建运行环境、注册自定义网址协议和管理单次项目运行所需的类型。`./simulator-ui` 提供模拟器界面；`./main/*` 与 `./shared/*` 提供消息转发、诊断、存储和资源地址等工具。只使用 `package.json` 中 `exports` 声明的入口。其他内部路径可能随版本变化。

## 仓库内开发

```bash
pnpm --filter @dimina-studio/electron-runtime build
pnpm --filter @dimina-studio/electron-runtime check-types
pnpm --filter @dimina-studio/electron-runtime test
pnpm --filter @dimina-studio/electron-runtime test:e2e
```

## License

[MIT](../../LICENSE)
