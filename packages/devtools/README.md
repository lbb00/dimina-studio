# @dimina-studio/devtools

Dimina DevTools 是调试 Dimina 小程序的 Electron 桌面应用，提供模拟器、Chrome DevTools、WXML、AppData、Storage、编译日志和代码编辑器。

![Dimina DevTools](../../docs/devtools.png)

## 获取和运行

桌面构建可从项目 [Releases](https://github.com/lbb00/dimina-studio/releases) 下载。从源码启动前，请先按[仓库根 README](../../README.md#从源码启动)准备环境：

```bash
pnpm --filter @dimina-studio/devtools build
pnpm --filter @dimina-studio/devtools start
```

## 作为 Electron 库使用

安装 DevTools、默认编译工具和对应版本的 Electron：

```bash
pnpm add @dimina-studio/devtools @dimina-studio/devkit electron@^43.2.0
```

主入口导出 `launch(config?)`。不要在主进程模块顶层 `await launch()`；应用就绪事件需要等待模块求值完成。

```ts
import { openProject } from '@dimina-studio/devkit'
import { launch } from '@dimina-studio/devtools'
import type { CompilationAdapter } from '@dimina-studio/devtools/types'

const adapter: CompilationAdapter = { openProject }

launch({
  appName: 'My Miniapp Studio',
  adapter,
  onSetup(instance) {
    instance.registerSimulatorApi('host.getVersion', () => ({ version: '1.0.0' }))
  },
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
```

其余公开入口包括 `./launch`、`./types`、`./simulator-ui`、`./context`、`./projects-provider`、`./create-window`、`./paths`、`./workbench-settings`、`./preload` 和 `./bootstrap`。配置字段、项目编译方法和应用扩展方式见[库集成参考](./docs/library-integration.md)。

## 文档

[文档索引](./docs/README.md)按使用、集成、架构、专题和维护整理全部 DevTools 文档。把 DevTools 放进自己的应用时，从[库集成](./docs/library-integration.md)开始；维护进程、窗口和原生视图时先读[总体架构](./docs/electron-container.md)。

## 仓库内开发

```bash
pnpm --filter @dimina-studio/devtools build
pnpm --filter @dimina-studio/devtools dev
pnpm --filter @dimina-studio/devtools check-types
pnpm --filter @dimina-studio/devtools test
pnpm --filter @dimina-studio/devtools test:e2e
```

`dev` 会先构建，再启动界面页、模拟器、主进程和预加载脚本的监听任务，最后打开 Electron。

## 地图组件（`<map>`）配置

Web 端 `<map>` 组件默认使用高德地图 Web 端 SDK，凭据从主进程环境变量读取，不写死在代码里：

| 环境变量 | 作用 | 是否必需 |
| --- | --- | --- |
| `DIMINA_AMAP_WEB_KEY` | 高德地图 Web 端 Key | 是，缺失时组件显示"未配置地图 Key" |
| `DIMINA_AMAP_PRIVACY_CONSENT` | 是否已同意高德地图服务条款，设为 `1` 或 `true` | 是，未同意时组件显示未授权提示 |
| `DIMINA_AMAP_SECURITY_JS_CODE` | 高德 Web 端安全密钥（`securityJsCode`），未申请代理服务时使用 | 否 |
| `DIMINA_AMAP_SERVICE_HOST` | 自建代理服务地址（`serviceHost`），设置后优先于 `DIMINA_AMAP_SECURITY_JS_CODE` | 否 |

设置后需要重启 devtools（这些变量只在主进程启动/`spawn` 时读取一次）。当前未提供 `wx.getLocation` 的模拟定位能力——devtools/dimina-electron-runtime 里没有现成的定位模拟实现可复用，`<map>` 组件依赖定位的交互（如"移动到当前位置"）在 studio 里不可用。

## 本地使用注意事项

该工具面向本地开发。不要在窗口或应用扩展中加载不受信任的远程内容。自定义消息通过 `onSetup(instance)` 中的 `instance.ipc` 注册；应用创建窗口后须调用 `instance.registerTrustedWindow(win)`。详见[维护说明](./docs/contributing.md#安全注意事项)。

## License

[MIT](../../LICENSE)
