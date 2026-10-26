# 内嵌编辑器集成

用户打开编辑器时，当前项目文件会显示在代码树中；按保存后，改动会写回项目目录。外部程序随后改了同一文件，已经打开的编辑器不会自动刷新。

DevTools 使用 `@dimina-studio/workbench` 提供浏览器中的 VS Code 编辑器。它从[为编辑器提供文件的本机网页服务](./glossary.md#为编辑器提供文件的本机网页服务coi-server)加载，不能直接访问 Node.js 文件系统。

## 当前数据流

```mermaid
flowchart LR
  Disk[项目目录] <--> Files[主进程文件读写]
  Files <--> Server[本机网页服务]
  Server <--> Workbench[编辑器视图]
  Workbench --> Types[类型与扩展注入]
```

打开项目时，主进程把当前项目和文件类型交给本机服务。`diskMirrorSource` 先把文件副本放进编辑器内存。用户保存时，`project-fs` 再把改动写回原项目目录。

## 常见问题

- 打开后文件为空：检查本机网页服务和 `project-fs` 是否拿到当前项目。
- 保存没有落盘：检查文件是否属于当前项目，以及主进程读写请求是否报错。
- 外部修改没有出现：这是当前行为，重新打开文件或编辑器后再读。

## 启动与构建

DevTools 的 `build:workbench` 调用工作台的 `build:app`，生成由本机网页服务提供的静态页面。`@dimina-studio/workbench` 的 `build` 只生成供其他 Vite 项目使用的配置，两种构建结果不能互换。

编辑器视图的创建、显示和关闭由主进程中的 `ViewManager` 管理。界面页只报告编辑器应该放在哪里，以及当前是否显示。

## 语言能力与类型

编辑器能识别 WXML，并用 JSON Schema 检查 Dimina 配置文件。它也提供运行环境的类型和受支持的扩展。`typings-injection` 将 `dd`、`wx` 等类型写入项目的类型目录；自定义文件类型通过 `{ template, style, viewScript }` 同时传给编译器和编辑器。

新增类型或扩展时，要确认本机网页服务能提供所需文件，而且扩展可以在浏览器中运行。不要让扩展依赖主进程内部路径。

## 主题与打开文件

主题由 DevTools 当前主题同步给工作台。`open-in-editor` 使用项目相对路径定位文件；调用方应先确认该文件属于当前项目，避免把任意本机路径交给编辑器。

## 维护入口

- `packages/workbench/src/`：编辑器 API、工作区来源和 Vite 预设。
- `src/main/services/workbench-coi-server.ts`：静态资源和文件桥。
- `src/main/ipc/project-fs.ts`：项目文件读写。
- `src/main/services/views/workbench-view.ts`：显示编辑器的 Electron 原生网页视图。
