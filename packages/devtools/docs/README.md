# DevTools 文档

Dimina DevTools 的使用说明和代码分工。

## 阅读路径

1. 使用桌面应用或把它接入自己的 Electron 应用，先读[包 README](../README.md)与[库集成](./library-integration.md)。
2. 维护窗口、视图或生命周期，读[总体架构](./electron-container.md)和[项目窗口布局](./project-window-layout.md)。
3. 维护模拟器、页面通信或平台 API，读[模拟器渲染](./simulator-render-architecture.md)和[小程序逻辑层和页面如何通信](./native-bridge-protocol.md)。
4. 维护代码编辑器，读[编辑器集成](./editor-integration.md)。

## 使用与集成

- [库集成](./library-integration.md)：安装、`launch()`、项目编译方法、项目来源和应用扩展。
- [文件系统](./file-system.md)：小程序可见路径、临时文件与上传。
- [MCP 服务](../src/main/services/mcp/README.md)：本机 AI 工具连接、能做什么和注意事项。
- [术语表](./glossary.md)：文档和代码中反复出现的名称。

## 架构

- [总体架构](./electron-container.md)：窗口、原生网页视图、消息和关闭顺序。
- [项目窗口布局](./project-window-layout.md)：布局树、原生视图放置和可见性。
- [模拟器渲染](./simulator-render-architecture.md)：设备外壳、缩放、安全区与重编译。
- [小程序逻辑层和页面如何通信](./native-bridge-protocol.md)：逻辑代码、页面和主进程如何传消息。
- [编辑器集成](./editor-integration.md)：工作台、文件镜像、类型与扩展。
- [调试面板怎样取得数据](./devtools-cdp-routing.mdx)：调试面板从哪些页面读取数据。

## 专题

- [页面栈](./page-stack.md)
- [TabBar](./tab-bar.md)
- [提前准备逻辑层窗口](./prewarm-webview.md)

## 维护

[贡献说明](./contributing.md)列出目录、常用检查和安全注意事项。改了用户能看到的行为时，更新对应文章；没有合适的文章再加专题。
