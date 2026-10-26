/**
 * Process-wide multiplexing for the bridge router's `ipcMain` channels.
 *
 * `installBridgeRouter` is per-window assembly: every workbench window gets its
 * own router closure over its own `RouterState`. `ipcMain.handle` accepts
 * exactly ONE handler per channel process-wide and throws on a second, and
 * `event.returnValue` on a sync channel is single-valued — so with several
 * windows open the invoke channels would fail to install and the sync reply
 * would come from whichever router answered last. This bridge-specific mux
 * installs a single real registration per channel and dispatches only to the
 * router that owns the calling webContents.
 */

import { ipcMain } from 'electron'
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import {
  windowHostsWebContents,
  type InvokeMuxEntry,
  type SyncMuxEntry,
} from 'electron-deck/main'

const invokeEntries = new Map<string, InvokeMuxEntry[]>()
const syncEntries = new Map<string, SyncMuxEntry[]>()
const syncListeners = new WeakMap<SyncMuxEntry[], (event: IpcMainEvent, ...args: unknown[]) => void>()

function claimedEntry<E, R>(entries: Array<{ claims(event: E): boolean; handle(event: E, ...args: unknown[]): R }>, event: E) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry?.claims(event)) return entry
  }
  return undefined
}

/**
 * Register a bridge-router invoke channel. Unlike the generic deck mux, a
 * sender without a router owner is rejected instead of reaching the newest
 * router: bridge IPC carries project/session capabilities.
 */
export function addMuxedInvokeHandler(channel: string, entry: InvokeMuxEntry): () => void {
  let entries = invokeEntries.get(channel)
  if (!entries) {
    entries = []
    invokeEntries.set(channel, entries)
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const live = invokeEntries.get(channel)
      const owner = live && claimedEntry(live, event)
      if (!owner) throw new Error('Bridge router IPC sender is not recognized')
      return owner.handle(event, ...args)
    })
  }
  entries.push(entry)
  return () => {
    const at = entries.indexOf(entry)
    if (at !== -1) entries.splice(at, 1)
    if (entries.length === 0 && invokeEntries.get(channel) === entries) {
      invokeEntries.delete(channel)
      ipcMain.removeHandler(channel)
    }
  }
}

/**
 * Register a synchronous bridge channel. A missing owner gets an explicit
 * null reply, so Electron never waits for a router that does not own it.
 */
export function addMuxedSyncListener(channel: string, entry: SyncMuxEntry): () => void {
  let entries = syncEntries.get(channel)
  if (!entries) {
    entries = []
    syncEntries.set(channel, entries)
    const listener = (event: IpcMainEvent, ...args: unknown[]): void => {
      const live = syncEntries.get(channel)
      const owner = live && claimedEntry(live, event)
      if (!owner) {
        event.returnValue = null
        return
      }
      owner.handle(event, ...args)
    }
    syncListeners.set(entries, listener)
    ipcMain.on(channel, listener)
  }
  entries.push(entry)
  return () => {
    const at = entries.indexOf(entry)
    if (at !== -1) entries.splice(at, 1)
    if (entries.length === 0 && syncEntries.get(channel) === entries) {
      syncEntries.delete(channel)
      const listener = syncListeners.get(entries)
      if (listener) ipcMain.removeListener(channel, listener)
      syncListeners.delete(entries)
    }
  }
}

/**
 * The webContents ledgers a router keeps. A sender recorded in any of them was
 * bound by THIS router, so it belongs to it — this is what makes the hidden
 * service-host window (a standalone BrowserWindow, hosted by no workbench
 * window) resolve to the router that spawned it.
 */
export interface RouterSenderLedger {
  serviceWcIdToAppSessionId: Map<number, string>
  simulatorWcIdToAppSessionIds: Map<number, Set<string>>
  wcIdToBridgeId: Map<number, string>
}

/**
 * Whether the router holding `ledger` and driving `win` owns `wc`.
 *
 * The ledgers answer for senders the router already knows (render guests,
 * simulator, and the out-of-window service host). The window check answers for
 * a sender's FIRST message — a spawn arrives from the device shell before any
 * ledger entry exists, but that shell is always inside its own window.
 */
export function routerOwnsSender(
  ledger: RouterSenderLedger,
  win: BrowserWindow | undefined,
  wc: WebContents | undefined,
): boolean {
  if (!wc || wc.isDestroyed()) return false
  if (ledger.serviceWcIdToAppSessionId.has(wc.id)) return true
  if (ledger.simulatorWcIdToAppSessionIds.has(wc.id)) return true
  if (ledger.wcIdToBridgeId.has(wc.id)) return true
  return windowHostsWebContents(win, wc)
}
