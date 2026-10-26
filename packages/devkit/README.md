# @dimina-studio/devkit

为 Dimina 小程序提供编译、预览服务器、文件监听和重新编译能力的 Node.js 开发工具包。

## 安装

```bash
pnpm add @dimina-studio/devkit
```

需要 Node.js 20 或更高版本。

## 快速开始

```ts
import { openProject } from '@dimina-studio/devkit'

const session = await openProject({
  projectPath: '/absolute/path/to/miniapp',
  port: 0,
  onRebuild: info => console.log('重新编译完成', info),
  onBuildError: error => console.error('重新编译失败', error),
})

console.log(`预览地址：http://127.0.0.1:${session.port}`)
await session.close()
```

`openProject()` 会等首次编译完成后再返回。返回值代表本次项目运行。调用 `session.rebuild()` 可手动重新编译；调用 `session.close()` 会关闭预览服务器、文件监听和编译进程。

## 常用选项

- `projectPath`：必填，小程序项目目录。
- `port`：默认 `0`，由系统选择可用端口。
- `watch`：默认 `true`，监听源文件变化。
- `autoReload`：默认 `true`，编译成功后刷新预览；纯样式变化会尝试热更新。
- `sourcemap`：默认 `false`，生成源码映射。
- `fileTypes`：追加模板、样式和视图脚本扩展名。
- `onRebuild`、`onBuildError`、`onLog`、`onWatcherError`：接收重编译、错误、编译输出和监听错误。

`outputDir` 与 `outputRoot` 用于控制产物位置，二者不能同时设置。关闭 `watch` 不会禁用 `session.rebuild()`。

## 其他公开入口

根入口还导出重新编译调度、后台编译线程（Worker）和日志过滤工具。`@dimina-studio/devkit/watch-ignore` 提供文件监听时要忽略的目录。要缩短首次编译的等待时间，可以调用 `enableCompileWorkerStandby()`；应用退出时再调用返回对象的 `dispose()`。

## 仓库内开发

```bash
pnpm --filter @dimina-studio/devkit build
pnpm --filter @dimina-studio/devkit check-types
pnpm --filter @dimina-studio/devkit test
```

## License

[MIT](../../LICENSE)
