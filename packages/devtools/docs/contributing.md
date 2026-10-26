# DevTools 维护说明

维护 `@dimina-studio/devtools` 时看这份说明。专题索引在[文档索引](./README.md)。

## 目录

- `src/main/`：Electron 启动、当前项目、进程消息（IPC）、窗口和原生视图。
- `src/renderer/`：主窗口界面、项目列表和布局。
- `src/simulator/`：模拟器页面、设备外壳和小程序 API。
- `src/service-host/`：运行小程序逻辑的隐藏窗口。
- `e2e/`：桌面应用真实路径测试。
- `docs/`：使用、集成与架构说明。

## 常用检查

在仓库根目录执行：

```bash
pnpm --filter @dimina-studio/devtools check-types
pnpm --filter @dimina-studio/devtools lint
pnpm --filter @dimina-studio/devtools test
pnpm --filter @dimina-studio/devtools test:e2e
```

改动主窗口、模拟器、原生视图或导航后，除自动化检查外还应走一次真实用户路径，并验证关闭再打开或第二次交互。

## 维护规则

主进程负责项目运行、消息和原生网页视图。界面页（`renderer`）只提交用户操作和位置。异步结果带递增编号（`generation`）；编号不是当前值时，说明它属于旧项目或旧窗口，不能更新画面。

新增进程消息时要校验参数和发送方，并说明关闭时如何停止监听、取消请求和清理资源。新增原生视图时必须接入 `ViewManager`，不要在其他模块直接修改视图的位置或排列顺序。

## 安全注意事项

不要给界面页、预加载脚本（`preload`）、模拟器或应用扩展暴露任意 Node.js、任意消息或任意调试执行能力。页面可访问的方法必须经过主进程消息转发。不要加载不受信任的远程内容。

## 文档

用户可见的行为、应用提供的方法或代码分工变化时，更新[文档索引](./README.md)中的对应文章。代码注释可以链接到对应专题，但不要链接已删除的设计过程文档。
