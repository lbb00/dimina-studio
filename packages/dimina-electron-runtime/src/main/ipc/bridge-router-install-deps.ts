import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { RuntimeContext } from '../runtime-context.js'
import type { RouterState } from './bridge-router-types.js'

/** Shared installation ownership; the router creates this once per RuntimeContext. */
export interface BridgeRouterInstallDeps {
  ctx: RuntimeContext
  state: RouterState
  runtimeAssets: NonNullable<RuntimeContext['assets']>
  ownsSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean
}
