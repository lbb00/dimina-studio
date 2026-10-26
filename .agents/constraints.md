# 约束判定表

| 约束 | 会失败的检查 | 运行方式 |
| --- | --- | --- |
| 持久化失败的回归测试必须验证实际存在的记录，不能用不存在的旧路径得到的两个 `undefined` 证明记录未丢失。 | `window-geometry.test.ts` 的写入、重命名、读取失败用例先断言记录集合非空，再比较失败前后的完整记录；同一项目读取失败后还必须恢复原尺寸。`window-geometry-files.test.ts` 使用真实临时文件验证不同 owner 的保存和旧格式迁移。 | `pnpm --dir packages/devtools exec vitest run src/main/windows/main-window/window-geometry.test.ts src/main/windows/main-window/window-geometry-files.test.ts src/main/utils/window-size.test.ts` |

修复问题时，行为 RED 与最终 GREEN 必须针对同一验收行为。补测此前已经正确的行为可以初次即通过，但不能将它报告为 bug 的 RED→GREEN。回放旧实现得到的失败应明确标为回放，并在回放后验证源码完整恢复。
