# 安全问题

请不要在公开 issue、pull request 或讨论里描述可以被利用的漏洞。

请到 [GitHub Security Advisories](https://github.com/lbb00/dimina-studio/security/advisories/new) 私下报告。说明会帮助维护者复现问题：

- 影响的包或桌面应用版本
- 操作系统和 Node.js 版本
- 复现步骤，以及攻击者需要具备的条件
- 你已经确认的影响范围

维护者确认后会回复，并在修复发布时说明影响版本和升级方式。

这个工具面向本机开发。不要在窗口、预加载脚本或应用扩展里加载不受信任的远程内容。把 DevTools 接进自己的应用时，请同时阅读 [安全注意事项](./packages/devtools/docs/contributing.md#安全注意事项)。
