# TabBar 怎样工作

TabBar 显示在设备框中，不在小程序页面容器（`render-host` `<webview>`）内。用户点标签时，会切换到该标签保存的页面历史。

## 正常流程

`switchTab` 选择标签并显示该标签当前页面。第一次进入标签时会创建根页面。普通页面不会变成标签页根页面。

| 分组 | 可调用的 API | 用户会看到什么 |
| --- | --- | --- |
| 外观 | `setTabBarStyle`、`setTabBarItem` | 颜色、文字或图标更新 |
| 显示 | `showTabBar`、`hideTabBar` | 标签栏显示或隐藏 |
| 提示 | `setTabBarBadge`、`removeTabBarBadge`、`showTabBarRedDot`、`hideTabBarRedDot` | 徽标或红点变化 |

## 谁负责什么

`DeviceShell` 提供设备外观。`tab-bar-state.ts` 保存选中项和动态设置。`miniapp-frame.tsx` 把状态画到页面区域。

## 出问题先查什么

- 点标签没有切换：检查标签是否在项目配置中，以及项目是否仍在运行。
- 徽标没有更新：检查 API 名称和当前标签页状态。
- 返回后页面不对：检查[页面栈](./page-stack.md)中的每标签历史。

相关代码在 `packages/dimina-electron-runtime/src/simulator-ui/tab-bar-state.ts` 和 `miniapp-frame.tsx`。
