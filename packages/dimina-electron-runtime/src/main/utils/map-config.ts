/**
 * 从主进程自己的环境变量解析 Web `<map>` provider 的凭据/同意状态。render-host guest
 * 自己读不到 process.env（见 render-host/preload.cjs、shared/dmb-resource-url.ts）——这
 * 是唯一决定studio 交给 guest 什么内容的地方，对应 upstream Web demo 的
 * `installDemoMapConfig` 读 Vite 环境变量。
 *
 * 命名对齐 upstream 的 `VITE_AMAP_*`（fe/packages/container/src/mapConfig.js），这样同一
 * 份高德控制台凭据两边都能用。
 */
export interface MapConfigEnv {
  key?: string
  securityJsCode?: string
  serviceHost?: string
  /** 原始同意值；render-host 自己的 config builder 接受 '1'/'true'。 */
  consent?: string
}

function trimmed(value: string | undefined): string | undefined {
  const t = value?.trim()
  return t ? t : undefined
}

export function resolveMapConfigEnv(env: NodeJS.ProcessEnv = process.env): MapConfigEnv {
  return {
    key: trimmed(env.DIMINA_AMAP_WEB_KEY),
    securityJsCode: trimmed(env.DIMINA_AMAP_SECURITY_JS_CODE),
    serviceHost: trimmed(env.DIMINA_AMAP_SERVICE_HOST),
    consent: trimmed(env.DIMINA_AMAP_PRIVACY_CONSENT),
  }
}
