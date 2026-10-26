# 项目窗口怎样摆放内容

WXML、Storage 等是普通 DOM 面板。模拟器、编辑器和 Chrome DevTools 是 Electron 原生网页视图（`WebContentsView`）。用户拖动分栏、切换标签或关闭面板时，两类内容都应同步移动或隐藏。

## 正常流程

```mermaid
flowchart LR
  User[用户拖动或切换面板] --> UI[界面页计算位置]
  UI --> Report[上报全部位置和显示状态]
  Report --> Main[主进程]
  Main --> Views[移动或隐藏原生网页视图]
```

界面页每次把所有原生视图的位置、尺寸和是否显示一起上报。主进程只采用最新一份，因此旧界面不能把已关闭的视图重新显示。

## 谁负责什么

`ViewManager` 是唯一可以创建、移动、隐藏和释放原生网页视图的代码。界面页只计算布局和报告结果。新增原生面板时，先增加稳定的面板名称和空槽位，再由主进程创建视图。

## 出问题先查什么

- 模拟器盖住按钮：检查界面页上报的槽位尺寸。
- 关闭面板后仍残留：检查是否上报了不可见状态。
- 切换项目后出现旧内容：检查旧项目的位置上报是否被忽略。

相关代码在 `src/renderer/modules/main/features/project-runtime/layout/`、`src/renderer/shared/renderer-placement-generation.ts`、`src/main/services/views/view-manager.ts` 和 `src/main/services/views/placement-reconciler.ts`。
