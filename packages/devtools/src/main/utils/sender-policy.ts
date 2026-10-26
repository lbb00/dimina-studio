import type { WebContents } from 'electron'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { SenderPolicy } from './ipc-registry.js'

/**
 * Default workbench sender white-list.
 *
 * An IPC message is accepted only when its `event.sender` matches one of
 * the WebContents the main process itself created and trusts:
 * - the main window's renderer
 * - the optional workbench settings BrowserWindow's renderer (when open)
 * - the settings overlay view (when open)
 * - the popover and tooltip overlay views (when open)
 *
 * The simulator webview is intentionally NOT on this list. Anything it
 * needs from main (currently just the custom-apis bridge — see
 * `installCustomApisBridge` in `src/preload/runtime/custom-apis.ts`) reaches
 * the host without being white-listed here via the native-host path:
 * the simulator is a top-level WebContentsView (no embedder), and its
 * custom-api traffic is dispatched by a `ctx.simulatorApis`-backed
 * `ipcMain.on` listener bound to that exact simWc in view-manager
 * `attachNativeCustomApiBridge` — it gates on the precise sender id rather
 * than this white-list. (Historically a `<webview>` simulator proxied through
 * the trusted main-window renderer via `ipcRenderer.sendToHost` + `<webview>.send`;
 * that renderer-proxied path no longer exists — native-host is the sole runtime.)
 * Keeping the guest off this list contains the blast radius if the
 * simulator content is ever compromised.
 *
 * Host-owned BrowserWindows registered via `instance.registerTrustedWindow`
 * are additionally accepted via `ctx.trustedWindowSenderIds`.
 *
 * Any other sender — including a stale/destroyed sender or an unknown
 * iframe — is rejected.
 */
export function createWorkbenchSenderPolicy(
  ctx: Pick<WorkbenchContext, 'windows' | 'views' | 'trustedWindowSenderIds'>,
): SenderPolicy {
  const ownsSender = createWorkbenchOwnedSenderCheck(ctx)
  return (sender: WebContents) => {
    if (ownsSender(sender)) return true
    if (sender.isDestroyed()) return false
    // Host-registered trusted windows (registerTrustedWindow). The map is
    // app-wide, so this is the one accepted sender no single context owns.
    return ctx.trustedWindowSenderIds.has(sender.id)
  }
}

/**
 * The senders this context structurally OWNS: its own main-window renderer,
 * its own settings window and the overlay views mounted inside it. Deliberately
 * excludes `trustedWindowSenderIds` — that map is shared by the whole app, so
 * every context would claim the same host window and ownership would stop being
 * unique. `createWindowContextRouter` routes on this check first for exactly
 * that reason.
 */
export function createWorkbenchOwnedSenderCheck(
  ctx: Pick<WorkbenchContext, 'windows' | 'views'>,
): SenderPolicy {
  // 仅信任随工具加载的覆盖层；宿主工具栏和模拟器内容不能取得全局 IPC 权限。
  const overlayIdGetters: Array<() => number | null> = [
    () => ctx.views.getSettingsWebContentsId(),
    () => ctx.views.getPopoverWebContentsId(),
    () => ctx.views.getTooltipWebContentsId(),
    () => ctx.views.getProjectCreateDialogWebContentsId(),
    () => ctx.views.getUpdateDialogWebContentsId(),
    () => ctx.views.getDevicePickerWebContentsId(),
    () => ctx.views.getCompileStatusDetailsWebContentsId(),
  ]
  return (sender: WebContents) => {
    if (sender.isDestroyed()) return false
    if (ctx.windows.isMainSender(sender.id)) return true
    if (ctx.windows.isSettingsWindowSender(sender.id)) return true
    return overlayIdGetters.some((getId) => {
      const id = getId()
      return id != null && sender.id === id
    })
  }
}
