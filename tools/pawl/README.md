# pawl 代码质量检查

本目录保存 dimina-studio 的 [pawl](https://github.com/tiangong-dev/pawl) 配置和测量脚本。它会比较当前代码与仓库保存的数据，防止代码质量指标变差。这个工具不会发布到 npm。

## 使用

在仓库根目录运行：

```bash
pnpm pawl:check
pnpm pawl:diff
pnpm pawl:record
pnpm exec pawl guard <git-ref>
```

`pawl:check` 把当前测量结果与 `pawl.snapshot.json` 中保存的参考值比较，结果变差时返回失败。`pawl:diff` 只显示变化。只有确认变化来自真实的代码改进后，才可以运行 `pawl:record` 更新参考值。

## 指标

配置位于仓库根目录的 [`pawl.yaml`](../../pawl.yaml)。当前检查文件长度、绕过类型检查的写法、函数逻辑复杂度、重复代码、循环依赖、类型覆盖率和测试覆盖率。pawl 直接计算一部分数据，`adapters/` 中的脚本计算其余数据并输出 JSON。

pawl 不会主动运行测试。检查测试数据前，要先运行受影响包的测试，让它们生成 `test-report*.json` 和 `coverage-summary.json`。缺少报告表示无法测量，不能当作零值。

## 添加指标

1. 在 `adapters/` 中添加一个测量脚本，并默认导出 `Adapter`。
2. 在 [`pawl.yaml`](../../pawl.yaml) 中登记 `node tools/pawl/pawl-adapter.ts <id>` 命令。
3. 为测量脚本添加测试。
4. 运行测试与 `pnpm pawl:diff`，确认测量正确后再保存新的参考值。

本目录的 TypeScript 由 Node.js 原生类型擦除执行。请只使用可擦除语法，并为本地 import 写上 `.ts` 或 `.js` 扩展名。单独检查该目录可运行：

```bash
pnpm exec tsc -p tools/pawl
```

## License

[MIT](../../LICENSE)
