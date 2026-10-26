// `globalThis.__DIMINA_MAP_CONFIG__`（studio 的 Web `<map>` provider 配置，见
// dimina/fe/packages/components/src/component/map/map-session.js）的纯构建函数。从
// preload.cjs 拆出来是为了能在 vitest 里直接 import，而不用连带 `require('electron')`；
// 必须始终和 preload.cjs 一起拷进 dist/render-host（见 build-native-host.js 的 ASSETS
// 列表），preload.cjs 运行时按相对路径 require 它。
//
// 对应 upstream 的 `installDemoMapConfig`（fe/packages/container/src/mapConfig.js）：
// `authorize()` 是"无 key"和"未同意"两种情况共用的唯一关卡——studio 没有 Web demo 的
// `.env.local`，可操作的修复方式是设环境变量后重启 devtools，而不是改文件。
// Map.vue's errorHint only ever shows one of three fixed strings — the actual
// env var to set never reaches the UI. Log it to the render-host console (the
// only place it's visible) before throwing, so the actionable message isn't
// silently dropped.
function failAuthorize(message) {
  console.error(`[render-host] map authorize: ${message}`)
  throw new Error(message)
}

function buildMapConfig({ key, securityJsCode, serviceHost, consent } = {}) {
  const trimmedKey = key && key.trim() ? key.trim() : ''
  const consented = consent === '1' || (consent || '').toLowerCase() === 'true'
  return {
    provider: 'amap',
    // 特意保留为可扩展对象：测试和未来的 host 侧 provider 往这里注册；
    // resolveMapProvider（dimina/fe registry.js）会先查这里，再查内置的 'amap'/'native'。
    providers: {},
    providerOptions: {
      amap: {
        key: trimmedKey,
        ...(serviceHost ? { serviceHost } : securityJsCode ? { securityJsCode } : {}),
      },
    },
    authorize() {
      if (!trimmedKey) {
        return failAuthorize(
          'AMap Web key is required：请设置环境变量 DIMINA_AMAP_WEB_KEY 后重启 devtools 以启用地图组件',
        )
      }
      if (!consented) {
        return failAuthorize(
          '地图服务尚未授权：请设置环境变量 DIMINA_AMAP_PRIVACY_CONSENT=1 表示已同意高德地图服务条款后重启 devtools',
        )
      }
      return true
    },
  }
}

module.exports = { buildMapConfig }
