import { app, BrowserWindow } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import path from "node:path"
import type { HostEnvSnapshot, SpawnRequest, SpawnResult } from "../../shared/bridge-channels.js"
import type { RuntimeContext } from "../runtime-context.js"
import { startDiminaResourceServer, type DiminaResourceServer } from "../services/dimina-resource-server.js"
import { miniappPartition } from "../services/views/miniapp-partition.js"
import { resolveRuntimeAssetPaths } from "../utils/paths.js"
import { buildServiceHostSpawnUrl, createServiceHostWindow, navigateServiceHost, serviceHostSpec } from "../windows/service-host-window/create.js"
import { bootServiceHost, reportPageNotFound } from "./bridge-router-boot.js"
import { disposeAppSession } from "./bridge-router-dispose.js"
import { orientationOfHostEnv, spawnHostEnvFor } from "./bridge-router-device-geometry.js"
import { pushRuntimeStatus, startLaunchTimer } from "./bridge-router-lifecycle.js"
import { buildAppManifest, isTabPage, loadAppConfig, normalizePagePath, resolvePageWindowConfig, resolveRootPagePath } from "./bridge-router-manifest.js"
import { clearLaunchTimer } from "./bridge-router-state.js"
import { bindSimulatorWc, bindWc, newBridgeId, resolveSimulatorWebContents } from "./bridge-router-transport.js"
import type { AppSession, PageSession, RouterState } from "./bridge-router-types.js"
import { createSessionListenerBag } from "./session-listener-bag.js"

export async function handleSpawn(
  state: RouterState,
  ctx: RuntimeContext,
  event: IpcMainInvokeEvent,
  opts: SpawnRequest,
): Promise<SpawnResult> {
  const runtimeAssets = ctx.assets ?? resolveRuntimeAssetPaths()
  const appId = opts.appId
  if (!appId) throw new Error('[bridge-router] spawn requires appId')
  const bridgeId = opts.bridgeId || newBridgeId()
  const appSessionId = bridgeId

  const simulatorWc = resolveSimulatorWebContents(ctx, opts.simulatorWcId, event.sender)
  const pagePath = normalizePagePath(opts.pagePath || 'pages/index/index')
  const workspaceProjectPath =
    typeof ctx.workspace.getProjectPath === 'function' ? ctx.workspace.getProjectPath() : ''
  // Must use the same appId/project-path pair as createEmbeddedMiniappView and
  // createServiceHostWindow. This is an authorization fact, not a value read
  // back from Electron's Session API (which cannot expose its partition).
  const resourcePartition = miniappPartition(appId, workspaceProjectPath || undefined)
  const pkgRoot = path.resolve(opts.pkgRoot || workspaceProjectPath || process.cwd())
  const root = opts.root || 'main'
  // Host-config custom API namespaces (RuntimeContext is the single owner).
  // Threaded into the service-host spawn URL so its preload can install the
  // namespace globals; the simulator-supplied `opts.apiNamespaces` is derived
  // from the same host config and is not authoritative here.
  const apiNamespaces = ctx.apiNamespaces ?? []
  // Host-registered custom API names (`ElectronRuntime.registerApi(...)`), read
  // fresh at spawn time since a host can register APIs any time before a spawn.
  // Threaded into the spawn URL so the preload can install
  // `globalThis.__diminaRegisteredApis` before service.js evaluates.
  const registeredApis = ctx.simulatorApis.list()

  // Resource base resolution. Preferred: the simulator-supplied dev-server
  // origin, which statically serves the compiled `<appId>/<root>/…` tree (same
  // source the default dimina-fe `<webview>` reads). Fallback (no dev server —
  // legacy/unit tests): a local server rooted at `pkgRoot/root`. Either way
  // `resourceBaseUrl` is the single base all fetches resolve against.
  let resourceServer: DiminaResourceServer | null = null
  let resourceBaseUrl: string
  if (opts.resourceBaseUrl) {
    resourceBaseUrl = opts.resourceBaseUrl.endsWith('/')
      ? opts.resourceBaseUrl
      : `${opts.resourceBaseUrl}/`
  } else {
    resourceServer = await startDiminaResourceServer(path.resolve(pkgRoot, root))
    resourceBaseUrl = resourceServer.baseUrl
  }
  // The selected device (renderer toolbar) is the authoritative source for the
  // logical dims a spawn must report (see `spawnHostEnvFor`). Read it AFTER
  // each await below, right before the value is used: a `setDevice` during
  // app-config load or pool acquire pushes its `hostEnvUpdate` only to
  // sessions already registered, so a snapshot captured before the await
  // would ship the previous device to this service host's first spawn.
  const resolveHostEnv = (): HostEnvSnapshot =>
    makeHostEnv(spawnHostEnvFor(opts.hostEnvSnapshot, ctx.bridge?.getDevice?.() ?? null))

  // app-config.json lives at `<base><appId>/<root>/app-config.json` on the dev
  // server, or at the local server root for the fallback path.
  const appConfig = await loadAppConfig(
    resourceServer ? resourceServer.baseUrl : `${resourceBaseUrl}${appId}/${root}/`,
    ({ url, error }) => {
      ctx.diagnostics?.report({
        severity: 'error',
        code: 'app-config-unreachable',
        message: `app-config.json unreachable at ${url}: ${String(error)}`,
        appSessionId,
      })
    },
  )
  const manifest = buildAppManifest(appConfig, pagePath)
  const { resolvedPagePath, pageFallbackApplied } = resolveRootPagePath(manifest, pagePath)
  if (pageFallbackApplied) {
    reportPageNotFound(ctx, appSessionId, pagePath, resolvedPagePath)
  }
  const rootWindowConfig = resolvePageWindowConfig(appConfig, resolvedPagePath)
  const isTab = isTabPage(appConfig, resolvedPagePath)
  let hostEnv = resolveHostEnv()

  // Acquire a pre-warmed service-host window when pooling is enabled; otherwise
  // construct one fresh (default). A pooled/fallback window is warmed on
  // about:blank and must be navigated to the spawn URL below; the fresh path
  // navigates inside createServiceHostWindow.
  const usedPool = state.pool !== null
  let poolEntryId: string | null = null
  let serviceWindow: BrowserWindow
  // Shared spawn-navigation failure handler (fresh AND pooled paths): without
  // it a loadURL rejection is fully swallowed — did-finish-load never fires and
  // the only signal is the launch watchdog's late timeout instead of the cause.
  const reportServiceHostNavigationFailed = (spawnUrl: string, err: unknown): void => {
    const message = `Failed to navigate service host to ${spawnUrl}: ${String(err)}`
    ctx.diagnostics?.report({
      severity: 'error',
      code: 'service-host-navigation-failed',
      message,
      appSessionId,
    })
    // The session registers after window construction; resolve it fresh so the
    // fresh-path callback (created pre-registration) still clears the watchdog.
    const ap = state.appSessions.get(appSessionId)
    if (ap) clearLaunchTimer(ap)
    pushRuntimeStatus(
      ctx,
      ap ?? {
        appId,
        pageFallback: pageFallbackApplied
          ? { requested: pagePath, resolved: resolvedPagePath }
          : null,
      },
      {
        phase: 'launch-failed',
        code: 'service-host-navigation-failed',
        reason: message,
      },
    )
  }
  if (state.pool) {
    const acquired = await state.pool.acquire(serviceHostSpec(undefined, undefined, runtimeAssets))
    serviceWindow = acquired.win
    poolEntryId = acquired.entryId
    hostEnv = resolveHostEnv()
  } else {
    const freshWindowOptions = {
      bridgeId,
      appId,
      // Same (appId, projectPath) pair the simulator WCV uses, so this project's
      // service host and render guests land on ONE partition while a different
      // project with the same appId is isolated. Use the path captured at spawn
      // ENTRY (workspaceProjectPath), not a re-read: a project switch during the
      // awaits above would otherwise give the service host a different path than
      // the simulator WCV was built with, splitting the partition.
      projectPath: workspaceProjectPath || undefined,
      pagePath: resolvedPagePath,
      pkgRoot,
      root,
      resourceBaseUrl,
      hostEnvSnapshot: hostEnv,
      apiNamespaces,
      registeredApis,
      assets: runtimeAssets,
    }
    serviceWindow = createServiceHostWindow({
      ...freshWindowOptions,
      onLoadFailed: err =>
        reportServiceHostNavigationFailed(buildServiceHostSpawnUrl(freshWindowOptions), err),
    })
  }

  // Derived from the snapshot this spawn actually reports, so a later
  // setDevice's orientation-changed check starts from the right side.
  const deviceOrientation = orientationOfHostEnv(hostEnv)
  const appSession: AppSession = {
    appSessionId,
    appId,
    pkgRoot,
    root,
    scene: opts.scene ?? 1001,
    serviceWindow,
    serviceWc: serviceWindow.webContents,
    simulatorWc,
    resourcePartition,
    serviceLoaded: false,
    logicInjected: null,
    resourceBaseUrl,
    resourceServer,
    hostEnv,
    deviceOrientation,
    visibleBridgeId: null,
    hostHidden: state.hostBackgrounded,
    appHiddenSent: false,
    appConfig,
    manifest,
    pages: new Map(),
    activeBridgeId: null,
    poolEntryId,
    onServiceBoot: null,
    listenerBag: createSessionListenerBag(),
    registryHandle: null,
    running: false,
    launchTimer: null,
    pageFallback: pageFallbackApplied ? { requested: pagePath, resolved: resolvedPagePath } : null,
    serviceLoadDeferred: false,
    serviceHostReady: false,
    pendingServiceMessages: [],
  }

  const rootPage: PageSession = {
    bridgeId,
    appSessionId,
    pagePath: resolvedPagePath,
    query: opts.query ?? {},
    isRoot: true,
    isTab,
    renderWc: null,
    renderLoaded: false,
    resourceLoadedSent: false,
    renderLoadPending: false,
    renderLoadSent: false,
    windowConfig: rootWindowConfig,
    supersededRenderWcIds: new Set(),
  }

  state.appSessions.set(appSessionId, appSession)
  state.pageSessions.set(bridgeId, rootPage)
  appSession.pages.set(bridgeId, rootPage)
  bindWc(state.serviceWcIdToAppSessionId, serviceWindow.webContents, appSessionId)
  bindSimulatorWc(state.simulatorWcIdToAppSessionIds, simulatorWc, appSessionId)
  // Track the service-host webContents as a Connection (the soft-reuse
  // teardown path documented in foundation.md) and
  // own this session's serviceWc→appSessionId binding on its CURRENT lifetime
  // segment. On a pooled-window REUSE, `disposeAppSession` calls
  // `connections.reset(serviceWc.id)` → this owned cleanup fires + a fresh
  // segment opens, so the next session rebinding the same wc starts clean; on a
  // real destroy the connection closes and fires it too. The cleanup is guarded
  // by `appSessionId` so it only clears a binding that is still THIS session's.
  // (The simulatorWc binding stays manual in `disposeAppSession`: the simulator
  // wc outlives individual app sessions — cross-connection state documented in
  // foundation.md — so it
  // cannot hang off any single session's segment.)
  state.connections.acquire(serviceWindow.webContents).own(() => {
    if (state.serviceWcIdToAppSessionId.get(appSession.serviceWc.id) === appSessionId) {
      state.serviceWcIdToAppSessionId.delete(appSession.serviceWc.id)
    }
  })
  appSession.registryHandle = ctx.registry.add(() => disposeAppSession(state, appSessionId))

  const onServiceClosed = (): void => {
    void disposeAppSession(state, appSessionId, { serviceAlreadyClosed: true })
  }
  appSession.listenerBag.once(serviceWindow, 'closed', onServiceClosed)

  // The simulator WCV owns the app's UI lifetime. When it is destroyed —
  // project close (`views.disposeAll`/detach) or a DeviceShell respawn
  // (`attachNativeSimulator`, e.g. watcher hot reload) — the guest never gets
  // to send its graceful `C.DISPOSE`, so without this hook the app session and
  // its hidden service-host window leak, and `resolveCurrentApp` keeps
  // resolving the STALE session for the same appId: `getActiveRenderWc` then
  // dereferences dead pages and every panel pull (WXML/elements) returns null
  // for the whole next session. Disposing here is idempotent with the graceful
  // path (`disposeAppSession` early-returns once the session is gone).
  const onSimulatorDestroyed = (): void => {
    void disposeAppSession(state, appSessionId)
  }
  appSession.listenerBag.once(simulatorWc, 'destroyed', onSimulatorDestroyed)
  // The simulator WCV may have been torn down DURING this spawn's awaits
  // (loadAppConfig / resource server / service-host creation) — e.g. a project
  // close/switch that ran while we were mid-flight. In that case its 'destroyed'
  // event already fired and the once() above will never run, so the freshly
  // registered session would be a zombie owned by a dead simulator (the
  // teardown's disposeSessionsForSimulator snapshot taken before appSessions.set
  // could not have included it). Dispose now — idempotent with the graceful
  // path — so a closed/superseded simulator can't leave a resurrected session.
  if (simulatorWc.isDestroyed()) {
    void disposeAppSession(state, appSessionId)
  }

  if (usedPool) {
    // A pooled/fallback window passes through about:blank (warm load or the
    // fallback's initial load). Boot only once the REAL service.html navigation
    // finishes — filtering by URL so an about:blank did-finish-load can't fire a
    // premature boot. The listener removes itself after the first match.
    const bootOnServiceLoad = (): void => {
      if (serviceWindow.isDestroyed()) return
      // This session was disposed before its service.html settled: self-evict so
      // a recycled window doesn't carry a stale listener into the next spawn.
      if (state.appSessions.get(appSessionId) !== appSession) {
        serviceWindow.webContents.removeListener('did-finish-load', bootOnServiceLoad)
        return
      }
      // Ignore the warm/about:blank load; only the real service.html boots.
      if (!serviceWindow.webContents.getURL().includes('service.html')) return
      serviceWindow.webContents.removeListener('did-finish-load', bootOnServiceLoad)
      void bootServiceHost(state, appSession, ctx)
    }
    appSession.onServiceBoot = bootOnServiceLoad
    serviceWindow.webContents.on('did-finish-load', bootOnServiceLoad)
    const spawnUrl = buildServiceHostSpawnUrl({
      bridgeId,
      appId,
      pagePath: resolvedPagePath,
      pkgRoot,
      root,
      resourceBaseUrl,
      hostEnvSnapshot: hostEnv,
      apiNamespaces,
      registeredApis,
      assets: runtimeAssets,
    })
    void navigateServiceHost(serviceWindow, spawnUrl, {
      onLoadFailed: err => reportServiceHostNavigationFailed(spawnUrl, err),
    })
  } else {
    // Fresh window: its only navigation is service.html (issued inside
    // createServiceHostWindow), so the first did-finish-load is the spawn load.
    serviceWindow.webContents.once('did-finish-load', () => {
      void bootServiceHost(state, appSession, ctx)
    })
  }

  // Service-host crash (renderer process gone): a session-scoped hook on the
  // service webContents, bound via the listener bag so `disposeAppSession`
  // detaches it (matching the 'closed'/'destroyed' hooks registered above).
  // Not a `.once` — a pooled service window can recover and crash again
  // across its lifetime, and each crash is independently worth surfacing.
  // Fires whether the crash lands before or after 'running'; only the launch
  // timer needs clearing (it may already be null) since a running session no
  // longer has one armed.
  const onServiceCrashed = (): void => {
    clearLaunchTimer(appSession)
    ctx.diagnostics?.report({
      severity: 'error',
      code: 'service-host-crashed',
      message: `Service host renderer process gone for appSessionId=${appSessionId}`,
      appSessionId,
    })
    pushRuntimeStatus(ctx, appSession, {
      phase: 'crashed',
      code: 'service-host-crashed',
    })
  }
  appSession.listenerBag.on(serviceWindow.webContents, 'render-process-gone', onServiceCrashed)

  pushRuntimeStatus(ctx, appSession, { phase: 'launching' })
  startLaunchTimer(state, ctx, appSession)

  return {
    appSessionId,
    bridgeId,
    pagePath,
    resolvedPagePath,
    pageFallbackApplied,
    serviceWcId: serviceWindow.webContents.id,
    resourceBaseUrl,
    root,
    manifest,
    rootWindowConfig,
  }
}

// ── Service-host boot & per-page resource handshake ──────────────────────────
// ── Message routing ──────────────────────────────────────────────────────────


function makeHostEnv(snapshot: Partial<HostEnvSnapshot> | undefined): HostEnvSnapshot {
  return {
    brand: "Dimina", model: "Electron", platform: process.platform,
    system: `${process.platform} ${process.versions.electron || ""}`.trim(),
    version: process.versions.electron || "0.0.0", SDKVersion: "native-host-phase-1",
    pixelRatio: 2, screenWidth: 390, screenHeight: 844, windowWidth: 390, windowHeight: 844,
    statusBarHeight: 24, language: app.getLocale(), theme: "light", ...snapshot,
  }
}
