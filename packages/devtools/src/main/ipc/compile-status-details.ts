import type { WorkbenchModule } from '../services/module.js'
import type { ViewManager } from '../services/views/view-manager.js'
import type { SessionStatusStore } from '../services/workspace/session-status-store.js'
import { CompileStatusChannel } from '../../shared/ipc-channels-overlays.js'
import type { Disposable } from 'electron-deck/main'
import { IpcRegistry, type SenderPolicy } from '../utils/ipc-registry.js'
import { toIpcContextSource, type IpcInput } from '../utils/ipc-context-source.js'

export interface CompileStatusDetailsIpcDeps {
  views: Pick<ViewManager, 'showCompileStatusDetails' | 'hideCompileStatusDetails'>
  sessionStatus: SessionStatusStore
  senderPolicy?: SenderPolicy
}

export function registerCompileStatusDetailsIpc(input: IpcInput<CompileStatusDetailsIpcDeps>): Disposable {
  const subscriptions = new Map<CompileStatusDetailsIpcDeps, () => void>()
  function stop(ctx: CompileStatusDetailsIpcDeps): void {
    subscriptions.get(ctx)?.()
    subscriptions.delete(ctx)
  }
  function follow(ctx: CompileStatusDetailsIpcDeps): void {
    stop(ctx)
    subscriptions.set(ctx, ctx.sessionStatus.subscribe((snapshot) => {
      if (snapshot.phase === 'error') ctx.views.showCompileStatusDetails(snapshot)
      else { stop(ctx); ctx.views.hideCompileStatusDetails() }
    }))
  }
  const registry = new IpcRegistry(toIpcContextSource(input))
    .onRouted(CompileStatusChannel.Show, (ctx) => {
      const snapshot = ctx.sessionStatus.get()
      if (snapshot.phase === 'error') follow(ctx)
    })
    .onRouted(CompileStatusChannel.Hide, (ctx) => { stop(ctx); ctx.views.hideCompileStatusDetails() })
  return { dispose() { for (const stopFollowing of subscriptions.values()) stopFollowing(); subscriptions.clear(); registry.dispose() } }
}

export const compileStatusDetailsModule: WorkbenchModule = {
  setup: (ctx) => registerCompileStatusDetailsIpc(ctx),
}
