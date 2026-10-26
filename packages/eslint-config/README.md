# @dimina-studio/eslint-config

dimina-studio 仓库内部共用的 ESLint 配置，使用 ESLint 9 的 flat config 格式。这个包不会发布到 npm。

## 使用

在 ESLint 配置中按需导入：

```js
import { config } from '@dimina-studio/eslint-config/base'

export default config
```

React 项目使用：

```js
import { config } from '@dimina-studio/eslint-config/react-internal'

export default config
```

`base` 包含 JavaScript、TypeScript、Prettier、Turbo 和仓库通用规则；`react-internal` 在此基础上加入 React、React Hooks 与浏览器环境配置。

配置依赖由仓库根目录管理，供仓库中的其他包直接使用。外部项目不应依赖这个私有包。

## License

[MIT](../../LICENSE)
