# @dimina-studio/inspect

这个包从正在运行的 Dimina 页面中读取 WXML 树，也提供显示 WXML、Storage、AppData 和编译信息的 React 面板。它可以放进不同的开发工具中。

## 安装

```bash
pnpm add @dimina-studio/inspect
```

核心入口不依赖 React。使用 `@dimina-studio/inspect/panel` 时，还需安装 React 18 或更高版本。

## 快速开始

在小程序页面中创建检查器。数据变化时，通知你的应用重新读取：

```ts
import { createWxmlInspector } from '@dimina-studio/inspect'

const inspector = createWxmlInspector({
  onMutated: () => console.log('WXML 已变化'),
})

const tree = inspector.getWxml()
inspector.dispose()
```

React 面板通过 `WxmlPanelSource` 读取当前数据，并接收后续变化：

```tsx
import type { WxmlPanelSource } from '@dimina-studio/inspect'
import { ConnectedWxmlPanel } from '@dimina-studio/inspect/panel'

export function Inspector({ source }: { source: WxmlPanelSource }) {
  return <ConnectedWxmlPanel source={source} />
}
```

面板会填满外层元素。请给外层元素设置高度和弹性布局，例如 `height: 100%; display: flex; flex-direction: column`。还要让 Tailwind 扫描本包源文件，并提供面板使用的 CSS 变量。

## 公开入口

- 主入口：读取 WXML 树、生成稳定元素 ID、创建检查器，以及整理 Storage、AppData 和面板数据的工具。
- `@dimina-studio/inspect/panel`：WXML、Storage、AppData、编译信息的纯 React 视图与 `Connected*Panel` 组件。

你的应用需要实现 `WxmlPanelSource`、`StoragePanelSource`、`AppDataPanelSource` 或 `CompilePanelSource`，再把它传给对应的面板组件。可以用 Electron 进程消息（IPC）、`postMessage` 或其他方式传输数据。每个实现都要同时提供“读取当前数据”和“接收后续变化”这两个方法。

## 仓库内开发

```bash
pnpm --filter @dimina-studio/inspect build
pnpm --filter @dimina-studio/inspect check-types
pnpm --filter @dimina-studio/inspect test
```

## License

[MIT](../../LICENSE)
