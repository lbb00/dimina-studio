# @dimina-studio/typescript-config

dimina-studio 仓库内部共用的 TypeScript 配置，不会发布为 npm 包。

## 使用

普通 TypeScript 包继承 `base.json`：

```json
{
  "extends": "@dimina-studio/typescript-config/base.json"
}
```

React 库继承 `react-library.json`：

```json
{
  "extends": "@dimina-studio/typescript-config/react-library.json"
}
```

`base.json` 使用严格模式、NodeNext 模块解析、ES2022 目标和 DOM 类型；`react-library.json` 在此基础上启用 `react-jsx`。各包仍应在自己的 `tsconfig.json` 中声明源文件、输出目录和特定编译选项。

## License

[MIT](../../LICENSE)
