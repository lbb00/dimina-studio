# @dimina-studio/design

dimina-studio 桌面界面共用的 CSS 变量、基础样式、可拖动面板样式和 Tailwind 配置。

## 安装

```bash
pnpm add @dimina-studio/design
```

## 快速开始

在应用入口引入完整样式：

```ts
import '@dimina-studio/design/css/index.css'
```

需要 Tailwind 工具类时，把本包提供的配置加入你的 Tailwind 配置：

```js
module.exports = {
  presets: [require('@dimina-studio/design/tailwind-preset')],
  content: ['./src/**/*.{html,ts,tsx}'],
}
```

`cn()` 用于合并 Tailwind 类名：

```ts
import { cn } from '@dimina-studio/design'

const className = cn('p-2', props.className)
```

## 样式入口与主题

- `css/index.css`：完整主题、基础样式和可拖动面板样式。
- `css/tokens.css`：CSS 变量；默认跟随系统颜色模式，`html.dark` 强制深色。
- `css/base.css`：元素基础样式。
- `css/deck.css`：停靠布局的标签页和拖拽分隔条样式。

应用可在 `index.css` 之后加载自己的 CSS，通过覆盖 `:root`、`.dark` 或 `[data-theme]` 中的变量定制配色。使用独立 HTML 页面时，请复制整个 `css/` 目录，保证其中的相对 `@import` 路径仍然有效。

## 仓库内开发

```bash
pnpm --filter @dimina-studio/design build
pnpm --filter @dimina-studio/design check-types
pnpm --filter @dimina-studio/design test
```

## License

[MIT](../../LICENSE)
