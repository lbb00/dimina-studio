import {
  ipcMain,
  shell,
  WebContentsView,
  type IpcMainEvent,
  type WebContents,
} from 'electron'
import type { RuntimeContext } from './runtime-context.js'
import {
  configureMiniappSession,
  miniappFileScope,
  miniappPartition,
} from './services/views/miniapp-partition.js'
import {
  handleCustomApiBridgeRequest,
  type CustomApiBridgeRequest,
} from './services/simulator/custom-apis.js'
import type { RuntimeAssetPaths } from './utils/paths.js'
import { SimulatorCustomApiBridgeChannel } from '../shared/bridge-channels.js'
import { allowRenderNavigation, allowSimulatorNavigation, PendingWebviewAttachments } from './navigation-policy.js'

export interface EmbeddedMiniappView {
  view: WebContentsView
  ready: Promise<void>
  dispose(): Promise<void>
}

export class ElectronRuntimeSessionDisposedError extends Error {
  readonly code = 'ERR_ELECTRON_RUNTIME_SESSION_DISPOSED'

  constructor() {
    super('Mini-app session was disposed before it became ready')
    this.name = 'ElectronRuntimeSessionDisposedError'
  }
}

function hardenNavigation(wc: WebContents, allow: (url: string) => boolean): void {
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  const blockUnexpectedNavigation = (event: Electron.Event, url: string): void => {
    if (allow(url)) return
    event.preventDefault()
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
  }
  wc.on('will-navigate', blockUnexpectedNavigation)
  wc.on('will-frame-navigate' as never, blockUnexpectedNavigation as never)
}

export function createEmbeddedMiniappView(
  ctx: RuntimeContext,
  options: {
    appId: string
    projectPath: string
    simulatorUrl: string
    assets: RuntimeAssetPaths
  },
): EmbeddedMiniappView {
  const partition = miniappPartition(options.appId, options.projectPath)
	const fileScope = miniappFileScope(partition)
	if (!fileScope) throw new Error('miniapp file scope is required')
  configureMiniappSession(partition)

  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false,
      sandbox: false,
      webviewTag: true,
      preload: options.assets.simulatorPreloadPath,
      partition,
      additionalArguments: [`--dimina-file-scope=${fileScope}`],
    },
  })
  const simulatorWc = view.webContents
  hardenNavigation(simulatorWc, url => allowSimulatorNavigation(url, options.simulatorUrl))

  let resolveReady: () => void
  let rejectReady: (error: unknown) => void
  let settled = false
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = () => {
      if (settled) return
      settled = true
      resolve()
    }
    rejectReady = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
  })
  // The SDK forwards this promise to the host, but disposal may happen before
  // the host starts awaiting it. Mark the internal promise handled while
  // preserving its rejected state for every external await.
  void ready.catch(() => {})

	const pendingFrames = new PendingWebviewAttachments<string | null>()
	simulatorWc.on('will-attach-webview', (event, preferences, params) => {
    ;(preferences as Electron.WebPreferences).partition = partition
    params.partition = partition
    preferences.contextIsolation = false
    ;(preferences as Electron.WebPreferences).sandbox = false
		pendingFrames.willAttach(event, typeof params.src === 'string' ? params.src : null)
	})
	simulatorWc.on('did-attach-webview', (_event, guest) => {
		const expectedFrame = pendingFrames.didAttach()
    hardenNavigation(guest, url => !!expectedFrame && allowRenderNavigation(url, expectedFrame))
    guest.once('did-finish-load', resolveReady)
  })

  const customApiHandler = (event: IpcMainEvent, request: unknown): void => {
    if (event.sender.id !== simulatorWc.id) return
    const value = request as CustomApiBridgeRequest | undefined
    if (!value || typeof value.id !== 'number') return
    void handleCustomApiBridgeRequest(ctx.simulatorApis, value).then((response) => {
      if (!simulatorWc.isDestroyed()) {
        simulatorWc.send(SimulatorCustomApiBridgeChannel.Response, response)
      }
    })
  }
  ipcMain.on(SimulatorCustomApiBridgeChannel.Request, customApiHandler)

  void simulatorWc.loadURL(options.simulatorUrl).catch((error) => {
    rejectReady(error)
  })

  let disposePromise: Promise<void> | null = null
  return {
    view,
    ready,
    dispose() {
      if (disposePromise) return disposePromise
      rejectReady(new ElectronRuntimeSessionDisposedError())
      disposePromise = (async () => {
        const errors: unknown[] = []
        try {
          ipcMain.removeListener(SimulatorCustomApiBridgeChannel.Request, customApiHandler)
        } catch (error) {
          errors.push(error)
        }
        try {
          await ctx.bridge?.disposeSessionsForSimulator?.(simulatorWc.id)
        } catch (error) {
          errors.push(error)
        }
        try {
          if (!ctx.windows.mainWindow.isDestroyed()) {
            ctx.windows.mainWindow.contentView.removeChildView(view)
          }
        } catch {
          // The host may have already detached the view; disposal stays idempotent.
        }
        try {
          if (!simulatorWc.isDestroyed()) simulatorWc.close()
        } catch (error) {
          errors.push(error)
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, 'Embedded mini-app view disposal failed')
        }
      })()
      return disposePromise
    },
  }
}
