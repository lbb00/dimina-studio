import type { BrowserWindow, WebContents } from 'electron'
import type {
  DeviceOrientation,
  NativeDeviceInfo,
} from '../../shared/runtime-types.js'
import type {
  AppManifest,
  HostEnvSnapshot,
  MessageEnvelope,
  PageStackEntry,
  PageWindowConfig,
  TabBarConfig,
} from '../../shared/bridge-channels.js'
import type { ConnectionRegistry, DebugTap, Disposable } from 'electron-deck/main'
import type { DiminaResourceServer } from '../services/dimina-resource-server.js'
import type { ServiceHostPool } from '../services/service-host-pool/pool.js'
import type { NativeWebSocketService, NativeWebSocketTrace } from '../services/native-websocket/index.js'
import type { NativeRequestService, NativeRequestTrace } from '../services/native-request/index.js'
import type { AppLifecycleController } from './app-lifecycle.js'
import type { SessionListenerBag } from './session-listener-bag.js'

export interface RawAppConfig {
  app?: {
    window?: PageWindowConfig
    tabBar?: TabBarConfig
    entryPagePath?: string
    pages?: string[]
    networkTimeout?: { connectSocket?: number }
    /** Compiler-emitted (`env.js` MINI_GAME_RUNTIME_TYPE): `'game'` for a mini-game, absent/anything else for a mini-program. */
    runtimeType?: string
  }
  // The compiler's actual `app-config.json` shape has each page's window-config
  // fields FLAT on `modules[path]` (no `.window` wrapper) — confirmed against a
  // live compiled fixture. `root` is carried alongside for the page's asset root.
  modules?: Record<string, (PageWindowConfig & { root?: string }) | undefined>
}

export interface AppSession {
  appSessionId: string
  appId: string
  pkgRoot: string
  root: string
  scene: number
  serviceWindow: BrowserWindow
  serviceWc: WebContents
  simulatorWc: WebContents
  /** Partition of the simulator WebContents. This is protocol authorization provenance. */
  resourcePartition: string
  serviceLoaded: boolean
  /**
   * Outcome of `injectLogicBundle`: `null` while injection is in-flight (or not
   * yet attempted), `true` once the compiled `logic.js` executed in the service
   * host, `false` if it could not be fetched/injected. The compiled bundle is
   * the ONLY source of the service AND render module registry (`modDefine`), so
   * a `false` here means a host `loadResource → modRequire('app')` is
   * GUARANTEED to throw the cryptic `module app not found` (and render
   * `module <pagePath> not found`). Both `loadResource` sends gate on this so we
   * surface one actionable diagnostic instead of that misleading cascade.
   */
  logicInjected: boolean | null
  /**
   * Base URL every resource fetch (render bundles, service logic.js,
   * app-config.json, the dmb-resource protocol proxy) is resolved against.
   * Under the simulator path this is the dev server origin
   * (`http://localhost:<port>/`), which statically serves the compiled
   * `<appId>/<root>/…` tree. When a caller doesn't supply one (legacy / unit
   * tests), we fall back to a local `DiminaResourceServer` rooted at the
   * spawn's `pkgRoot/root` and use its baseUrl here.
   */
  resourceBaseUrl: string
  /** Local fallback server; null when `resourceBaseUrl` is an external (dev) server. */
  resourceServer: DiminaResourceServer | null
  hostEnv: HostEnvSnapshot
  /** Orientation `hostEnv`'s dims imply, seeded at spawn and kept in step by
   *  `setDevice` — the geometry-change comparison's "did orientation flip"
   *  half, since a same-dims-different-orientation device is still a resize. */
  deviceOrientation: DeviceOrientation
  /** bridgeId of the page currently shown, per the lifecycle events this
   *  session's own PAGE_LIFECYCLE stream reports — null when no page is
   *  visible (before the first pageShow, or after the visible page hides/
   *  unloads with nothing shown yet). `setDevice` reads this to know which
   *  page (if any) a geometry change's `pageResize` targets: WeChat never
   *  delivers onResize to a hidden page. */
  visibleBridgeId: string | null
  /** Whether the host window (main window minimize/hide) currently has this
   *  session backgrounded — distinct from `visibleBridgeId`, which tracks
   *  page-level visibility WITHIN a foregrounded host. Drives
   *  `installAppLifecycleDriver`'s per-session hide/show dedup and gates
   *  `handlePageLifecycle`: while true, a UI-driven pageShow/pageHide is not a
   *  real WeChat show/hide (the host isn't on screen), so it only updates
   *  `visibleBridgeId` bookkeeping instead of forwarding to the service — the
   *  driver's own `show` transition sends the deferred pageShow once the host
   *  is actually back in the foreground. Snapshotted from `RouterState
   *  .hostBackgrounded` at spawn (a session created while the host is
   *  already backgrounded starts hidden), then kept in step by the driver. */
  hostHidden: boolean
  /** What `syncAppVisibility` has actually delivered to this session's
   *  service: mirrors `hostHidden` once in sync, diverges whenever
   *  `hostHidden` changes before `serviceLoaded` is true. Starts `false`
   *  (not `hostHidden`) because service's own App() construction is itself
   *  an implicit onLaunch/onShow (mirrors dimina jscore.ts's
   *  `sentAppVisible` baseline) — `syncAppVisibility` only needs to correct
   *  that baseline if `hostHidden` was already true by the time the App got
   *  built. Before `serviceLoaded`, `runtime.appShow()/appHide()` silently
   *  no-op (`this.app` doesn't exist yet) and are never redelivered, so this
   *  field — not `hostHidden` itself — gates actually sending appHide/
   *  appShow and the paired pageHide/pageShow for the visible page. */
  appHiddenSent: boolean
  appConfig: RawAppConfig
  manifest: AppManifest
  pages: Map<string, PageSession>
  /** Visible top-of-stack page bridgeId reported by DeviceShell (ACTIVE_PAGE).
   * Null until the first signal — callers fall back to the root bridgeId
   * (= appSessionId). Main has no z-order concept of its own; this mirrors the
   * DeviceShell ShellState so panels/automation can target the current page.
   * Read through `resolveActiveBridgeId`, which applies the root fallback —
   * both the public accessors and `ensureRenderBound`'s re-emit check share
   * that one definition of "active" rather than re-deriving it. */
  activeBridgeId: string | null
  /** Full ordered page stack (bottom→top) last reported by DeviceShell
   * (PAGE_STACK). Undefined until the first signal; automation's
   * `App.getPageStack` falls back to the single active page then. */
  pageStack?: PageStackEntry[]
  /** Pool entry id when the service window came from the pre-warm pool; null
   * for a fresh / fallback window (destroyed, not pooled, on dispose). */
  poolEntryId: string | null
  /** The pool-path `'did-finish-load'` boot listener, kept so dispose can detach
   * it before releasing the (recycled) window — otherwise a stale listener could
   * boot this disposed session into the next spawn's window. Null on the fresh
   * path (which uses a self-removing `once`). */
  onServiceBoot: (() => void) | null
  /** Session-scoped hooks on emitters that OUTLIVE this session — the shared
   * simulator WCV's `'destroyed'` and the service window's `'closed'` — are
   * registered through this bag so `disposeAppSession` detaches them all in
   * one place. A hook left behind on the shared simulator wc grows by one per
   * soft reload until the MaxListeners warning fires; a stale `'closed'` hook
   * on a pool-recycled window re-triggers this session's teardown. */
  listenerBag: SessionListenerBag
  /** Handle for this session's `ctx.registry` shutdown-fallback entry. Disposed
   * on normal session teardown so the registry doesn't grow one stale closure
   * per respawn (the fallback only needs to fire at whole-app shutdown for
   * sessions still live then). */
  registryHandle: Disposable | null
  /**
   * Whether this session has reached `'running'` (its root page reported
   * `domReady`). Gates the single 'launching' → 'running' transition — a
   * second `domReady` on the same session (e.g. a tab re-render) must not
   * re-fire the notification.
   */
  running: boolean
  /**
   * `LAUNCH_TIMEOUT_MS` watchdog armed at the end of `handleSpawn`. Cleared
   * the moment the session settles one way or another (running, launch
   * failure, crash, or disposal) so a stale timer can never fire a
   * 'launch-failed' after the session has already resolved — see
   * `clearLaunchTimer`.
   */
  launchTimer: NodeJS.Timeout | null
  /**
   * The start-page fallback applied at spawn (`resolveRootPagePath`), or null
   * when the requested page was mounted verbatim. A fact about the WHOLE
   * launch round, not any single phase: every runtime-status push carries it
   * (see `pushRuntimeStatus`), so a later phase change (e.g. 'running') cannot
   * silently drop it while the renderer's fallback banner is still showing it.
   */
  pageFallback: { requested: string; resolved: string } | null
  /**
   * A mini-game's service `loadResource` is held by `bootServiceHost` until the
   * root render guest reports `renderHostReady`. The game runtime runs game.js
   * synchronously inside that handler and its top-level `wx.createCanvas()`
   * messages render immediately — a render guest that is not listening yet
   * drops the canvas, and every later draw flush then warns `canvas node <id>
   * not found` against a permanently blank screen. Released by
   * `releaseDeferredServiceLoad`.
   */
  serviceLoadDeferred: boolean
  /**
   * Whether the service window has actually loaded `service.html` and its
   * preload has installed the `TO_SERVICE` listener — flipped true at the top
   * of `bootServiceHost`, the same real `did-finish-load` moment both the pool
   * and fresh spawn paths gate their boot call on (see `bootOnServiceLoad` /
   * the fresh `.once`). `forwardToService` queues into
   * `pendingServiceMessages` instead of calling `send` while this is false:
   * Electron's `send` is fire-and-forget, so a message sent while the window
   * is still on its warm/about:blank preload (no `bridgeId`, no listener) or
   * mid-navigation is gone for good, not buffered by Electron itself.
   */
  serviceHostReady: boolean
  /** Messages `forwardToService` received before `serviceHostReady`, in
   *  arrival order. Flushed once by `bootServiceHost` the moment it flips the
   *  flag; discarded untouched if the session is disposed first (a stale
   *  did-finish-load, or a pool boot listener that self-evicts on the disposed
   *  check, never reaches the flush). */
  pendingServiceMessages: MessageEnvelope[]
}

export interface PageSession {
  bridgeId: string
  appSessionId: string
  pagePath: string
  query: Record<string, unknown>
  isRoot: boolean
  isTab: boolean
  renderWc: WebContents | null
  renderLoaded: boolean
  resourceLoadedSent: boolean
  /**
   * The render guest reported `renderHostReady` while logic injection was still
   * in-flight (`ap.logicInjected === null`), so its render `loadResource` is
   * held: sending it before injection settles would race a failed bundle and
   * emit the cryptic `module <pagePath> not found`. `bootServiceHost` flushes
   * this on success and drops it on failure. The render guest fires
   * `renderHostReady` on its own `DOMContentLoaded`, which routinely beats the
   * async fetch+inject — without holding, the gate could only catch the rare
   * already-settled case.
   */
  renderLoadPending: boolean
  /** The render `loadResource` for this page actually went out on the wire —
   * i.e. the render guest exists and is listening. A game session's service
   * `loadResource` gates on the root page's flag (see `serviceLoadDeferred`). */
  renderLoadSent: boolean
  windowConfig: PageWindowConfig
  /**
   * webContents ids that were once bound as this page's `renderWc` and were
   * then replaced by a newer guest (see `ensureRenderBound`'s swap branch). A
   * late RENDER_INVOKE/RENDER_PUBLISH arriving from one of these — the old
   * guest was never destroyed, just superseded — must not reclaim `renderWc`
   * or re-emit `activePage` on its behalf. Entries are released when that
   * webContents is actually destroyed (see the `own()` cleanup below).
   */
  supersededRenderWcIds: Set<number>
}

export interface PendingApiCall {
  appSessionId: string
  callbacks: { success?: unknown; fail?: unknown; complete?: unknown }
  name: string
  /**
   * No-handler timeout. Cleared (and set to undefined) once a persistent
   * (`keep: true`) subscription produces its first fire, since such a call
   * stays pending until page/app teardown rather than timing out.
   */
  timer: NodeJS.Timeout | undefined
}

export interface RouterState {
  appSessions: Map<string, AppSession>
  pageSessions: Map<string, PageSession>
  /** serviceWc → appSessionId. One hidden service-host window per session, so
   * this stays single-valued; a pooled window reused by a later session simply
   * rebinds its wc id. */
  serviceWcIdToAppSessionId: Map<number, string>
  /** simulatorWc → the app sessions it hosts, in spawn (insertion) order. One
   * simulator WCV owns SEVERAL live sessions at once (soft reload keeps the
   * outgoing session alive while the incoming one boots), so the binding is a
   * Set: membership authorizes the wc for any session it hosts, and insertion
   * order lets sender→session resolution pick the latest spawn. */
  simulatorWcIdToAppSessionIds: Map<number, Set<string>>
  /** renderWc → bridgeId. */
  wcIdToBridgeId: Map<number, string>
  /** requestId → pending API_CALL forwarded to a simulator window. */
  pendingApiCalls: Map<string, PendingApiCall>
  /** Pre-warm pool for service-host windows; null when pooling is disabled. */
  pool: ServiceHostPool | null
  /** Fan-out for render-side activity (domReady / active-page); set in install. */
  emitRenderEvent: (event: RenderEvent) => void
  /** Fan-out for `ServiceHostReadyEvent`; set in install. */
  emitServiceHostReady: (event: ServiceHostReadyEvent) => void
  /** The most recent `ServiceHostReadyEvent`, for `onServiceHostReady`'s
   * missed-signal catch-up (a subscriber registering after the event already
   * fired for the still-live session must not wait forever) — re-validated
   * against `appSessions`/`serviceWc.isDestroyed()` at catch-up time, never
   * replayed blindly. Null before the first session ever boots. */
  lastServiceHostReady: ServiceHostReadyEvent | null
  /**
   * Per-webContents connection registry (see foundation.md). Render guests and
   * service-host windows are acquired here so their per-wc bookkeeping tears
   * down with the connection (destroy → close, pool reuse → reset) instead of
   * bespoke `once('destroyed')` listeners scattered through the router.
   */
  connections: ConnectionRegistry
  /**
   * Flag-gated ring buffer (see foundation.md) over the cross-wc bridge message
   * stream. Off by default (near-free no-op); when `DIMINA_DEBUG_TAP=1` it
   * records every SERVICE_INVOKE / RENDER_INVOKE / *_PUBLISH / API_RESPONSE at
   * the dispatch chokepoint (connection id + appSession + channel + direction)
   * so the cross-wc state machine is inspectable. This is debugTap's first real
   * consumer — the observability hangs on the LIVE runtime, not the
   * not-yet-integrated async envelope.
   */
  debugTap: DebugTap
  /**
   * App-level lifecycle listeners (wx.onAppShow / onAppHide / onError) keyed by
   * appSessionId. Fired on main-window foreground/background and service errors.
   */
  appLifecycle: AppLifecycleController
  /** Physical foreground/background state of the main window, owned
   *  exclusively by `installAppLifecycleDriver` (a real hide/minimize or
   *  show/restore edge flips this exactly once — see its own dedup). Each
   *  `AppSession.hostHidden` is snapshotted from this at spawn and then
   *  tracked per-session so a session's own view of "hidden" can lag this
   *  (e.g. before `serviceLoaded`) without corrupting the shared signal. */
  hostBackgrounded: boolean
  /** Main-process WebSocket transport. Uses Node net/tls through `ws`, never Chromium. */
  nativeWebSocket: NativeWebSocketService
  /** Main-process HTTP transport for wx.request. Uses Node http/https, never Chromium
   *  — no Origin header, no Fetch/CORS algorithm, no preflight. */
  nativeRequest: NativeRequestService
  /**
   * Evict the app's accumulated AppData bridges (panel registry) for every
   * page of the session. Lives on RouterState because `disposeAppSession` is
   * the single teardown chokepoint shared by BOTH dispose paths — graceful
   * `C.DISPOSE` and the simulator-WCV `'destroyed'` hook. Inlining eviction at
   * one call site (as the graceful handler once did) leaves the other path
   * with ghost AppData tabs after a respawn.
   */
  evictAppDataBridges: (ap: AppSession) => void
}

/** Default timeout for a simulator-forwarded API call. */

/**
 * Accessor over the bridge-router's private `RouterState`, stashed on
 * `ctx.bridge` so other main-process services (simulator-storage, automation,
 * appdata) can resolve live WebContents handles without owning router state.
 * All getters resolve fresh each call (the pre-warm pool can swap windows on
 * respawn, so cached handles go stale).
 */
/**
 * Render-side activity worth re-reading panel data on: a page's DOM mounted
 * (`domReady`), the resolvable active render guest changed (`activePage`), or
 * the active page's DOM mutated in place (`domMutated`, from the render-guest
 * MutationObserver). Panels that pull from the active render guest (WXML/
 * element-inspect) subscribe via `BridgeRouterHandle.onRenderEvent` so they
 * can refresh without polling.
 *
 * `activePage` fires on either of two triggers: DeviceShell reporting a new
 * top-of-stack page (ACTIVE_PAGE), or that active page's render guest
 * completing its bind. A page can become active before its guest exists
 * (SPAWN/PAGE_OPEN don't know the guest webContents up front), so on the
 * shell-reported event `getActiveRenderWc()` may still be null; the bind
 * event then follows once the guest is resolvable. Subscribers must tolerate
 * a null guest on any single event, but never need to special-case which
 * trigger fired: after the last event, `getActiveRenderWc()` reflects the
 * current state.
 */
export interface RenderEvent {
  kind: 'domReady' | 'activePage' | 'domMutated'
  appId: string
  bridgeId: string
  /** activePage only: the now-visible page's route (bare pagePath), if known.
   * Lets the current-page panel push the route without a separate lookup. */
  pagePath?: string
  /** activePage only: the now-visible page's launch query (the URL spec's
   * query params, `scene` already stripped by the simulator boot). Carried
   * alongside `pagePath` so the current-page panel can show and restore the
   * page's params across recompiles — bare `pagePath` alone loses them. */
  query?: Record<string, unknown>
}

/**
 * Fires once per app session, the moment its hidden SERVICE HOST window's
 * `service.html` document has `did-finish-load`'d — i.e. `serviceWcId` is
 * GUARANTEED resolvable via `webContents.fromId(serviceWcId)` right now. This
 * is document readiness, NOT mini-app runtime readiness: `injectLogicBundle`
 * and the service's own `serviceResourceLoaded` handshake both happen AFTER
 * this fires (see `bootServiceHost`) — a consumer that needs "the mini-app
 * has actually booted" must not treat this as that signal.
 *
 * Exists so a consumer that needs to act on the service host wc THE MOMENT it
 * becomes resolvable (e.g. attaching the right-panel DevTools front-end) has
 * a real event to react to instead of polling `getServiceWc(appId)` on a
 * fixed retry budget and silently giving up if that budget is exhausted
 * before the wc resolves under load — the bug this event was added to fix
 * (see `native-simulator-devtools-host.ts`'s `onServiceHostReady` subscriber).
 *
 * `appId`-keyed resolution (`getServiceWc(appId)`) is NOT equivalent to this
 * event during same-app respawn overlap — `getServiceWc` returns the MOST
 * RECENT live session for that appId, which may not be the specific session
 * that just fired this event. Consumers that must target the EXACT session
 * should resolve `serviceWcId` directly rather than re-resolving by `appId`.
 */
export interface ServiceHostReadyEvent {
  appId: string
  appSessionId: string
  serviceWcId: number
}

/**
 * Point-in-time counts of every resource class RouterState owns. Leak coverage
 * (unit + e2e) asserts EXACT equality of this ledger around a churn cycle —
 * coarse memory sampling cannot see a leaked listener or a stale map entry, so
 * the owner of the bookkeeping reports precise counts instead.
 */
export interface BridgeResourceCensus {
  appSessions: number
  pageSessions: number
  serviceWcBindings: number
  /** Distinct live simulator webContents currently hosting ≥1 session. */
  simulatorWcs: number
  /** Total session memberships across all simulator wcs. */
  simulatorWcBindings: number
  renderWcBindings: number
  pendingApiCalls: number
  /**
   * `listenerCount('destroyed')` per unique live simulator wc (keyed by wc id).
   * One teardown hook per live session — a count above the hosted-session count
   * is the one-dead-listener-per-soft-reload leak class.
   */
  simulatorDestroyedListeners: Record<number, number>
}
export type { BridgeOwnerSnapshot } from './bridge-owner-snapshot.js'

export interface BridgeRouterHandle {
  /** Whether native-host mode is on (main is the source of truth). */
  isNativeHost(): boolean
  /** The render-host `<webview>` WebContents for a page bridgeId, or null. */
  resolveRenderWc(bridgeId: string): WebContents | null
  /** The hidden service-host window WebContents for the active (or named) app. */
  getServiceWc(appId?: string): WebContents | null
  /** The service-host window WebContents for the app that owns a page bridgeId,
   * or null. Lets render-side consumers (console forwarder) target the matching
   * app's service host even with multiple sessions open. */
  getServiceWcForBridge(bridgeId: string): WebContents | null
  /** The visible page's render WebContents for the active (or named) app. */
  getActiveRenderWc(appId?: string): WebContents | null
  listOwnerSnapshots?(): import('./bridge-owner-snapshot.js').BridgeOwnerSnapshot[]
  /** The visible top-of-stack page bridgeId for the active (or named) app. */
  getActiveBridgeId(appId?: string): string | null
  /** The full ordered page stack (bottom→top) reported by DeviceShell, or null
   * before the first PAGE_STACK signal. Optional: only the native-host bridge
   * provides it (the default path derives the stack from the simulator URL). */
  getPageStack?(appId?: string): PageStackEntry[] | null
  /** The current (or named) app session's resource-server baseUrl (serves
   * that session's framework js/css), or null when no matching session
   * exists. Per-session, never a global singleton — see AppSession.resourceBaseUrl. */
  getResourceBaseUrl?(appId?: string): string | null
  /** Subscribe to render-side activity (domReady / active-page change). */
  onRenderEvent(listener: (event: RenderEvent) => void): () => void
  /** Subscribe to a service host's `did-finish-load` readiness (see
   * `ServiceHostReadyEvent`'s doc comment). A subscriber registering after
   * the still-live session's event already fired gets a missed-signal
   * catch-up — it never needs to poll. */
  onServiceHostReady(listener: (event: ServiceHostReadyEvent) => void): () => void
  /** Subscribe to the native WebSocket transport's trace stream (created /
   * handshake / frame / close per socket, keyed by owner appSessionId). Pure
   * observation — subscribing never alters API forwarding. Each `created`
   * socketId is guaranteed exactly one terminal `closed`. Optional so partial
   * test mocks of the handle need not stub it. */
  onNativeWebSocketTrace?(
    listener: (ownerId: string, event: NativeWebSocketTrace) => void,
  ): () => void
  /** Subscribe to the native HTTP request transport's trace stream (sent /
   * response / finished / failed per request, keyed by owner appSessionId).
   * Pure observation — subscribing never alters request forwarding. Each
   * `sent` requestId is guaranteed exactly one terminal event (`finished`
   * XOR `failed`). Optional so partial test mocks of the handle need not
   * stub it. */
  onNativeRequestTrace?(listener: (ownerId: string, event: NativeRequestTrace) => void): () => void
  /** The currently-selected device (renderer toolbar), or null pre-selection. */
  getDevice(): NativeDeviceInfo | null
  /** Cache the selected device, push DEVICE_CHANGE to the live simulator
   *  WC(s), and mirror the change into every spawned service via
   *  hostEnvUpdate (+ pageResize for whichever page is currently visible,
   *  when the geometry actually changed). */
  setDevice(device: NativeDeviceInfo): void
  /**
   * Deterministically tear down every app session bound to the given simulator
   * WebContentsView id (project close / DeviceShell respawn). The session
   * mappings are cleared, the render-host guest webContents are closed, and the
   * service-host window is closed/released — synchronously, instead of waiting
   * on the WCV's async `'destroyed'` cascade — so the next project never
   * re-resolves or screenshots the outgoing project's render guest. Idempotent
   * with the `simulatorWc.once('destroyed')` hook (`disposeAppSession`
   * early-returns once a session is gone). Optional so partial test mocks of the
   * handle need not stub it.
   *
   * The synchronous prefix of the underlying disposeAppSession clears every map
   * + closes the render guests + the service window before it awaits, so the
   * bridge is clean the moment this is called. The returned promise resolves
   * after the async tail (pool.release / resourceServer.close) so the lifecycle
   * owner can sequence a reopen after full teardown. NOTE: disposeAppSession
   * catches and logs pool/resource-release failures internally, so the promise
   * resolves rather than rejecting on those — it is a completion signal, not an
   * error channel.
   */
  disposeSessionsForSimulator?(simulatorWcId: number): Promise<void>
  /**
   * The router's resource ledger (see BridgeResourceCensus). Optional so the
   * many partial BridgeRouterHandle test mocks don't each have to stub it.
   */
  census?(): BridgeResourceCensus
  /**
   * The flag-gated debugTap (see foundation.md) over the bridge message stream. Exposed so a
   * hidden devtools panel / automation can read `.entries()` when
   * `DIMINA_DEBUG_TAP=1`; a no-op snapshot otherwise. Optional so the many
   * partial `BridgeRouterHandle` test mocks don't each have to stub it.
   */
  debugTap?: DebugTap
}
