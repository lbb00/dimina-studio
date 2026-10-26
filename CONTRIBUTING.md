# Contributing

欢迎给 dimina-studio 提交 issue 和 pull request。这份指南适用于整个仓库。只修改桌面工具 `@dimina-studio/devtools` 时，还可以阅读它自己的[维护说明](./packages/devtools/docs/contributing.md)。

参与讨论和提交代码时请遵守 [行为准则](./CODE_OF_CONDUCT.md)。

## 报告问题

缺陷和建议使用 GitHub issue 模板，写清你看到的结果、期望的结果和复现步骤。可以被利用的漏洞不要写进公开 issue，请按 [SECURITY.md](./SECURITY.md) 私下报告。

## 准备环境

克隆时要带上 Git 子模块，因为编译器需要读取 `dimina/` 中的源码。根仓库和 `dimina/fe` 分别安装一次依赖：

```bash
git clone --recurse-submodules https://github.com/lbb00/dimina-studio.git
cd dimina-studio
pnpm install
pnpm -C dimina/fe install
```

环境要求见根 [README](./README.md#从源码启动)。`dimina/` 是 Git 子模块，本仓库不修改它的内容。

## 分支与提交

- 从 `main` 切分支，命名 `<type>/<summary>`（如 `fix/devtools-console-denoise`、`feat/host-layout-slots`）。
- 提交信息使用 Conventional Commits 格式：`<type>(<scope>): <说明>`。`type` 表示改动类型，可用 `feat`、`fix`、`docs`、`test` 等。`scope` 表示改动的软件包，可以省略。说明可以用中文。
- 本仓库接受 AI 辅助写的代码。提交说明可以加 `Co-authored-by` 尾注，CI 不检查。代码和验证结果由提交者负责。

## 提交 PR 前

从仓库根目录运行完整检查：

```bash
./scripts/gate.sh
```

它依次执行 `pnpm run lint`、`pnpm exec turbo run check-types --force`、`pnpm run test` 和 `pnpm run pawl:check`；任一步失败就停止并打印日志路径。也可以单独运行根脚本（`pnpm lint`、`pnpm check-types`、`pnpm test`）。`pnpm test:coverage` 是额外的覆盖率检查，不属于 `gate.sh`。

`pawl:check` 会比较当前代码与仓库保存的质量数据。新增或扩写 `packages/*/src/**/*.{ts,tsx}` 时，文件长度不能超过 500 行；过度复杂的函数和绕过类型检查的写法也不能增加。用法见 [`tools/pawl`](./tools/pawl/README.md)。

## PR 要求

- 一个 PR 只做一件可独立验证的事；不要在同一个 PR 里混无关的重构和 lint 修复。
- PR 描述清楚说明改了什么、为什么改；涉及行为变化的改动附上验证方式（跑了哪些测试、e2e 或手工验证步骤）。
- CI（`.github/workflows/ci.yml`）会检查格式和类型，并运行测试与代码质量检查。推送前请先在本地运行 `./scripts/gate.sh`。
