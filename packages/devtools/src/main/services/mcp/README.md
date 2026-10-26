# 用 MCP 操作 DevTools

MCP 服务让本机 AI 工具打开项目、看编译结果和操作模拟器。它默认关闭，只监听本机地址。

在设置中开启，或写入 `<userData>/dimina-workbench-settings.json`：

```json
{ "mcp": { "enabled": true, "port": 7789 } }
```

```bash
codex mcp add dimina --url http://127.0.0.1:7789/sse
```

最短工作流程：

```text
project_open → simulator_get_overview → 修改项目文件 → project_wait_ready → simulator_screenshot
```

`project_open`、`project_close`、`project_status`、`project_wait_ready` 和 `compile_logs` 管项目与编译。`simulator_get_overview`、截图、DOM、控制台、网络、导航和输入管小程序页面。工作台工具只读。

连不上时先确认设置已启用、端口没有被占用，并检查地址是 `127.0.0.1`。项目或页面切换后，重新查询状态；旧页面 ID、DOM 节点和 JavaScript 执行环境不能继续使用。不要通过端口转发把服务暴露给不可信网络。
