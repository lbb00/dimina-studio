# 把 DevTools 放进自己的 Electron 应用

`launch()` 会启动模拟器、调试面板和编辑器。项目编译默认交给 devkit，也可以换成自己的打开方式，或在启动后注册小程序 API。

## 先跑起来

安装包、Electron 和默认编译工具：

```bash
pnpm add @dimina-studio/devtools @dimina-studio/devkit electron@^43.2.0
```

```ts
import { openProject } from '@dimina-studio/devkit'
import { launch } from '@dimina-studio/devtools'
import type { CompilationAdapter } from '@dimina-studio/devtools/types'

const adapter: CompilationAdapter = { openProject }

launch({
  appName: 'My Miniapp Studio',
  adapter,
  onSetup(instance) {
    instance.registerSimulatorApi('host.getVersion', () => ({ version: '1.0.0' }))
  },
}).catch(error => {
  console.error(error)
  process.exit(1)
})
```

不要在主进程模块顶层 `await launch()`。Electron 要等模块执行结束后才会进入 ready 状态。

## 常用配置

`launch(config)` 接收 `WorkbenchAppConfig`。完整类型在 `@dimina-studio/devtools/types`。

| 字段 | 什么时候设置 | 作用 |
| --- | --- | --- |
| `appName` | 想显示自己的产品名 | 设置窗口标题和默认名称 |
| `adapter` | 要使用自己的编译方式 | 打开项目，返回端口、项目信息和关闭方法 |
| `fileTypes` | 项目有额外模板或样式扩展名 | 让编译器和编辑器把它们识别为正确语言 |
| `onBeforeOpenProject` | 打开前要检查权限或目录 | 返回错误时，本次打开停止 |
| `onSetup` | 要增加应用提供的方法 | 注册小程序 API、窗口扩展和可信窗口 |

项目数据来源和模板也可以替换。它们决定项目列表显示什么，以及用户点“新建项目”时能选择什么。不要让界面页直接修改应用的配置文件。

## `onSetup` 和 `setupProjectWindow` 分别做什么

`onSetup(instance)` 在应用启动后执行一次。这里适合注册整个应用都能使用的内容，例如 `registerSimulatorApi()` 和可信应用窗口。术语解释见[术语表](./glossary.md)。

`setupProjectWindow` 用于只属于一个项目窗口的内容，例如额外工具条、侧边栏或监听器。项目关闭时，DevTools 会清理这里登记的内容。不要把项目相关的监听器保存在全局变量中。

应用工具条通过 `instance.context.views.hostToolbar` 加载自己的页面。这个页面只能调用明确提供的方法，不能直接访问 Node.js、任意 Electron API 或其他窗口。

## 出问题先看哪里

- 项目打不开：检查 `adapter.openProject()` 是否返回 `port`、`appInfo` 和 `close()`。
- 编译后没有画面：先确认预览地址能访问，再看[模拟器如何显示页面](./simulator-render-architecture.md)。
- 新增 API 没有响应：确认它在 `onSetup` 中注册，且名称与小程序调用一致。
- 原生网页视图盖住界面：看[项目窗口布局](./project-window-layout.md)。

## 可用入口

`@dimina-studio/devtools` 和 `./launch` 用于启动。`./types` 提供配置类型。`./projects-provider` 用于项目列表和模板。`./create-window`、`./paths`、`./workbench-settings`、`./preload`、`./bootstrap` 与 `./simulator-ui` 是已发布的扩展入口。不要从未导出的内部路径导入。
