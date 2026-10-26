const { ipcRenderer } = require('electron')

const CHANNELS = {
  RENDER_INVOKE: 'dmb:render:invoke',
  RENDER_PUBLISH: 'dmb:render:publish',
  TO_RENDER: 'dmb:to-render',
}

const params = new URLSearchParams(globalThis.location && globalThis.location.search || '')
const bridgeId = params.get('bridgeId')
const pagePath = params.get('pagePath') || 'pages/index/index'
const bgColor = params.get('bgColor')
const pendingMessages = []
let onMessageFn = null
let drainScheduled = false

if (!bridgeId) {
  throw new Error('[render-host] missing bridgeId in URL query')
}

// WeChat parity: prime the page's OWN document with its configured
// `window.backgroundColor` before pageFrame.css / @dimina/render load. Without
// this the guest's document background is UA-default white until the page's
// own CSS paints, which is the white flash on every page transition. Applied
// as early as the preload can reach `document.documentElement` and again on
// DOMContentLoaded in case the element wasn't attached yet.
//
// `documentElement` only — never `body`. `body` carries the `.dd-page` class
// that `installPageFrameStyleScopes` (dimina/fe render runtime) gates the page's
// own `data-v-*` scope attributes on, which makes `body` the element that
// `page { ... }` rules from the app's wxss compile down to. An inline
// background-color there outranks any stylesheet rule, so it would silently
// override the app's own `page { background-color: ... }` with this
// window-config default.
//
// Upstream's `applyPageStyle()` (container-sdk webview.ts) is NOT a precedent
// for touching the guest's body: the `root` it colors is
// `.dimina-native-webview__root`, the container element OUTSIDE the guest
// iframe. Our equivalent of that layer is the host-side `<webview>` element's
// own CSS (see miniapp-frame.tsx), which stays as the first white-flash
// primer; this `documentElement` write is the second.
if (bgColor) {
  const applyBackgroundColor = () => {
    if (document.documentElement) document.documentElement.style.backgroundColor = bgColor
  }
  applyBackgroundColor()
  globalThis.addEventListener('DOMContentLoaded', applyBackgroundColor)
}

const { buildMapConfig } = require('./map-config.cjs')

// Studio 版的 upstream `installDemoMapConfig`（dimina/fe/packages/container/src/
// mapConfig.js）：Web `<map>` 组件从 globalThis 读这个对象（map-session.js），只有主
// 进程知道高德凭据（见 main/utils/map-config.ts）——通过 dmb-resource URL 的查询参数
// 带过来，因为 guest preload 读不到主进程自己的 process.env。用 writable/configurable
// 的普通属性（不是 upstream 那种按 mapRenderer 门控的 getter——studio 没有原生容器共享
// 这份 bundle），这样测试/e2e 能整体替换它。
Object.defineProperty(globalThis, '__DIMINA_MAP_CONFIG__', {
  value: buildMapConfig({
    key: params.get('mapKey') || undefined,
    securityJsCode: params.get('mapSecurityJsCode') || undefined,
    serviceHost: params.get('mapServiceHost') || undefined,
    consent: params.get('mapConsent') || undefined,
  }),
  writable: true,
  configurable: true,
})

function reportError(stage, error) {
  const message = error && error.stack ? error.stack : String(error)
  console.error(`[render-host] ${stage}`, error)
  ipcRenderer.send(CHANNELS.RENDER_INVOKE, {
    bridgeId,
    msg: {
      type: 'componentError',
      target: 'container',
      body: { bridgeId, stage, message },
    },
  })
}

function parseMessage(rawMsg) {
  return typeof rawMsg === 'string' ? JSON.parse(rawMsg) : rawMsg
}

function deliver(msg) {
  if (!onMessageFn) {
    pendingMessages.push(msg)
    return
  }
  try {
    onMessageFn(msg)
  } catch (error) {
    reportError('onMessage', error)
  }
}

function scheduleDrain() {
  if (drainScheduled) return
  drainScheduled = true
  queueMicrotask(() => {
    drainScheduled = false
    while (onMessageFn && pendingMessages.length > 0) {
      deliver(pendingMessages.shift())
    }
  })
}

Object.defineProperty(globalThis, 'DiminaRenderBridge', {
  value: {
    get onMessage() {
      return onMessageFn
    },
    set onMessage(handler) {
      onMessageFn = typeof handler === 'function' ? handler : null
      scheduleDrain()
    },
    invoke(rawMsg) {
      ipcRenderer.send(CHANNELS.RENDER_INVOKE, { bridgeId, msg: parseMessage(rawMsg) })
    },
    publish(rawMsg) {
      ipcRenderer.send(CHANNELS.RENDER_PUBLISH, { bridgeId, msg: parseMessage(rawMsg) })
    },
  },
  writable: false,
  configurable: false,
})

ipcRenderer.on(CHANNELS.TO_RENDER, (_event, payload) => {
  deliver(payload && payload.msg)
})

globalThis.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.send(CHANNELS.RENDER_INVOKE, {
    bridgeId,
    msg: {
      type: 'renderHostReady',
      target: 'container',
      body: { bridgeId, pagePath },
    },
  })
})

// ── Console capture (native-host) ───────────────────────────────────────────
// This preload runs with contextIsolation effectively off (it defines globals on
// globalThis the page reads), so patching `console` here captures the render
// guest's own console output. Each entry is forwarded to main as a `consoleLog`
// container message (source:'render') — bridge-router routes it to ctx.guestConsole
// → automation rebroadcasts it as App.logAdded. Mirrors the shape used by
// src/preload/instrumentation/console.ts + runtime/host.ts safeSerialize.

function safeSerializeArg(val) {
  if (val === null || val === undefined) return val
  if (typeof val === 'function') return `[Function: ${val.name || 'anonymous'}]`
  if (typeof val !== 'object') return val
  if (val instanceof Error) return { __isError: true, message: val.message, stack: val.stack }
  try {
    return structuredClone(val)
  } catch (_) { /* DOM nodes / proxies can't be structuredCloned */ }
  try {
    return JSON.parse(JSON.stringify(val))
  } catch (_) { /* circular / non-serializable */ }
  return String(val)
}

function emitConsoleLog(level, args) {
  try {
    globalThis.DiminaRenderBridge.invoke({
      type: 'consoleLog',
      target: 'container',
      body: {
        bridgeId,
        source: 'render',
        level,
        args: args.map(safeSerializeArg),
        ts: Date.now(),
      },
    })
  } catch (_) { /* never let console capture break the guest */ }
}

;['log', 'warn', 'error', 'info', 'debug'].forEach((level) => {
  const original = typeof console[level] === 'function' ? console[level].bind(console) : null
  if (!original) return
  console[level] = (...args) => {
    original(...args)
    emitConsoleLog(level, args)
  }
})

globalThis.addEventListener('error', (event) => {
  emitConsoleLog('error', [{
    message: event.message,
    source: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    stack: event.error && event.error.stack,
  }])
})

globalThis.addEventListener('unhandledrejection', (event) => {
  emitConsoleLog('error', [{ message: 'Unhandled Promise Rejection', reason: String(event.reason) }])
})
