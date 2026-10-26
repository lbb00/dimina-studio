# @dimina-studio/workbench

这是一个可以放进浏览器页面的代码编辑器。它为 Dimina 小程序提供 WXML 支持、类型提示、配置文件检查和自动保存。

## 安装

```bash
pnpm add @dimina-studio/workbench
```

主入口发布的是 TypeScript 源码，需要由浏览器项目中的 Vite 处理。不要在纯 Node.js 程序中直接导入。

## 快速开始

```ts
import { bootWorkbench, inMemorySeedSource } from '@dimina-studio/workbench'

await bootWorkbench({
  container: document.getElementById('workbench')!,
  workspace: inMemorySeedSource({ fetchUrl: '/demo/base-app.json' }),
  theme: 'dark',
})
```

将本包提供的设置合入应用的 Vite 配置：

```ts
import { defineConfig, mergeConfig } from 'vite'
import { workbenchVitePreset } from '@dimina-studio/workbench/vite'

export default defineConfig(mergeConfig(workbenchVitePreset(), {}))
```

这份 Vite 配置会处理编辑器依赖、后台线程（Worker）、CSS 和开发时使用的静态文件。可通过 `features` 关闭 `wxml`、`jsonSchemas`、`ambientTypings` 或 `contributedExtensions`。

## 工作区来源

- `inMemorySeedSource({ files | fetchUrl })`：把固定文件载入内存，保存后不写回磁盘。
- `diskMirrorSource({ fsBaseUrl })`：通过应用提供的文件接口读取项目，保存时写回磁盘。

也可以自行实现 `WorkspaceSource`，告诉编辑器怎样读取和保存文件。`fileTypes` 接受 `{ template, style, viewScript }`，用于识别额外的文件扩展名。

## 构建方式

`build`（即 `build:lib`）只生成发布给 Vite 配置使用的 `./vite` 入口。`build:app` 生成独立的浏览器应用到 `dist-app/`，供桌面工具托管。两者面向不同产物，桌面工具需要后者。

## 仓库内开发

```bash
pnpm --filter @dimina-studio/workbench build
pnpm --filter @dimina-studio/workbench build:app
pnpm --filter @dimina-studio/workbench check-types
pnpm --filter @dimina-studio/workbench test
```

## License

[MIT](../../LICENSE)
