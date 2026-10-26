/**
 * Wires the `difile://_tmp/*` protocol handler on the simulator session
 * and bridges renderer-side `setTempFileSink` callbacks to the main-process
 * byte store. Returned disposable clears the store, unregisters the protocol
 * handler, and tears down its private IPC channels.
 *
 * SENDER POLICY: The default workbench sender-policy intentionally rejects
 * the simulator `<webview>` (see `utils/sender-policy.ts`). The simulator
 * is the only legitimate writer for these channels, so this module installs
 * its own narrow policy that accepts a sender only when its WebContents
 * belongs to the simulator `Session` we were handed. This bypasses the
 * default policy without widening trust to any other source.
 *
 * WRITE-vs-RENDER RACE: `createTempFilePath` is synchronous on the renderer,
 * but the bytes travel here through `blob.arrayBuffer().then(ipcRenderer.send)`
 * — async. The simulator can race ahead: in `chooseMedia` the renderer
 * assigns `img.src = tempFilePath` (via `readImageMetadata`) immediately
 * after `createTempFilePath` returns, which fires a `difile://` GET before
 * our IPC write arrives. The protocol handler therefore parks a request on
 * a per-url waiter for up to PENDING_TIMEOUT_MS; the IPC `write` handler
 * drains the waiter on arrival.
 *
 * QUOTA: A single in-memory store backs all simulator sessions for the
 * lifetime of the WorkbenchApp instance. We cap it at MAX_STORE_ENTRIES
 * (FIFO eviction). Project switches do NOT clear the store on their own —
 * stale entries from a previous project simply age out as new ones land.
 * This is the same eviction shape WeChat uses for tmp files (LRU under a
 * size cap), simplified for a dev-tools session scope.
 */

import type { Session } from 'electron'
import { RuntimeIpcRegistry, type SenderPolicy } from '../../ipc/ipc-registry.js'
import { toDisposable, type Disposable } from 'electron-deck/main'
import { type TempFileStore } from './resolver.js'
import { registerTempFile, revokeTempFile, revokeAllTempFiles } from './store.js'
import { handleDifileRequest } from './request-handler.js'
import { registerMiniappSessionConfigurator } from '../views/miniapp-partition.js'
import { miniappFileScope } from '../views/miniapp-partition.js'
import {
	handleFsMkdir,
	handleFsRead,
	handleFsReaddir,
	handleFsStat,
	handleFsUnlink,
	handleFsWrite,
} from './fs-channels.js'

/** Upper bound for in-memory entries; oldest insertion is evicted (FIFO). */
const MAX_STORE_ENTRIES = 200

/** Max time the protocol handler waits for an in-flight `write` IPC. */
const PENDING_TIMEOUT_MS = 500

export class ScopedTempStores {
	private readonly stores = new Map<string, TempFileStore>()
	private readonly fifo: Array<{ scope: string; path: string }> = []
	storeFor(scope: string): TempFileStore {
		let store = this.stores.get(scope)
		if (!store) { store = new Map(); this.stores.set(scope, store) }
		return store
	}
	write(scope: string, path: string, mime: string, bytes: ArrayBuffer | Buffer): void {
		this.remove(scope, path); registerTempFile(this.storeFor(scope), path, mime, bytes); this.fifo.push({ scope, path })
		while (this.fifo.length > MAX_STORE_ENTRIES) { const oldest = this.fifo.shift(); if (oldest) this.storeFor(oldest.scope).delete(oldest.path) }
	}
	revoke(scope: string, path: string): void { revokeTempFile(this.storeFor(scope), path); this.remove(scope, path) }
	revokeAll(scope: string): void { revokeAllTempFiles(this.storeFor(scope)); this.remove(scope) }
	clear(): void { this.stores.clear(); this.fifo.length = 0 }
	private remove(scope: string, path?: string): void { for (let i = this.fifo.length - 1; i >= 0; i--) { const entry = this.fifo[i]; if (entry && entry.scope === scope && (path === undefined || entry.path === path)) this.fifo.splice(i, 1) } }
}

export function setupSimulatorTempFiles(simSession: Session): Disposable {
	const scopedStores = new ScopedTempStores()
	const scopes = new Map<Session, string>([[simSession, 'shared']])
	const pendingWaiters = new Map<string, Set<() => void>>()
	let disposed = false

	function waiterKey(scope: string, path: string): string {
		return `${scope}\u0000${path}`
	}

	function drainWaiters(scope: string, path: string): void {
		const key = waiterKey(scope, path)
		const list = pendingWaiters.get(key)
		if (!list) return
		pendingWaiters.delete(key)
		for (const fn of list) fn()
	}

	function drainAllWaiters(): void {
		const lists = Array.from(pendingWaiters.values())
		pendingWaiters.clear()
		for (const list of lists) for (const fn of list) fn()
	}

	// The protocol handler + IPC channels are shared across every per-project
	// miniapp partition session (each project's render/service runs the same
	// difile:// + temp-file FSM). The base session is always trusted; additional
	// per-project partition sessions register themselves via `installOnSession`.
	const trustedSessions = new Set<Session>([simSession])
	const simulatorOnlyPolicy: SenderPolicy = sender =>
		!sender.isDestroyed() && trustedSessions.has(sender.session)

	const registry = new RuntimeIpcRegistry(simulatorOnlyPolicy)

	type TempFileWritePayload = {
		path: string
		mime: string
		bytes: ArrayBuffer | Buffer
	}

	function scopeFor(session: Session): string {
		const scope = scopes.get(session)
		if (!scope) throw new Error('simulator file scope is required')
		return scope
	}
	const storeFor = (scope: string) => scopedStores.storeFor(scope)
	function writeTempFile(scope: string, payload: TempFileWritePayload): void {
		if (disposed) throw new Error('simulator temp-file service is disposed')
		const { path, mime, bytes } = payload
		scopedStores.write(scope, path, mime, bytes)
		drainWaiters(scope, path)
	}

	registry.on('simulator:temp-file:write', (event, payload: TempFileWritePayload) => {
		if (disposed) return
		writeTempFile(scopeFor(event.sender.session), payload)
	})

	registry.handle('simulator:temp-file:write-confirmed', (event, payload: TempFileWritePayload) => {
		writeTempFile(scopeFor(event.sender.session), payload)
	})

	registry.on('simulator:temp-file:revoke', (event, payload) => {
		if (disposed) return
		const { path } = payload as { path: string }
		scopedStores.revoke(scopeFor(event.sender.session), path)
	})

	registry.on('simulator:temp-file:revoke-all', event => {
		if (disposed) return
		const scope = scopeFor(event.sender.session)
		scopedStores.revokeAll(scope)
	})

	const difileHandler = (fileScope: string) => async (req: { url: string; headers: { forEach: (cb: (v: string, k: string) => void) => void } }): Promise<Response> => {
		const url = req.url
		// Forward any HTTP headers Electron parsed (Range / If-None-Match)
		// to the pure dispatcher so it can do its own conditional / range
		// shaping.
		const headers: Record<string, string> = {}
		try {
			req.headers.forEach((v, k) => { headers[k] = v })
		}
		catch {
			// Older Electron headers shape may not be iterable — best effort.
		}
		const ctx = { tempStore: storeFor(fileScope), fileScope }
		let res = await handleDifileRequest(ctx, { url, headers })

		// Race waiter: the renderer-side `createTempFilePath` is synchronous
		// but its `bytes` IPC arrives later. If we miss a `_tmp/*` lookup,
		// park briefly and retry once.
		if (
			res.status === 404
			&& !disposed
			&& url.startsWith('difile://_tmp/')
		) {
			await new Promise<void>((resolve) => {
				let timer: ReturnType<typeof setTimeout> | null = null
				const notify = (): void => {
					if (timer) clearTimeout(timer)
					resolve()
				}
				const key = waiterKey(fileScope, url)
				const list = pendingWaiters.get(key) ?? new Set<() => void>()
				list.add(notify)
				pendingWaiters.set(key, list)
				timer = setTimeout(() => {
					const cur = pendingWaiters.get(key)
					if (cur) {
						cur.delete(notify)
						if (cur.size === 0) pendingWaiters.delete(key)
					}
					resolve()
				}, PENDING_TIMEOUT_MS)
			})
			res = await handleDifileRequest(ctx, { url, headers })
		}
		return res
	}

	// Install the difile:// protocol handler on a session. Idempotent per
	// session: a stale handler from a prior setup (e.g. fast app re-init in
	// tests) is replaced rather than throwing. Trusts that session's senders for
	// the temp-file / fs IPC channels.
	const installedSessions = new Set<Session>()
	let unregisterConfigurator: (() => void) | null = null
	function installOnSession(sess: Session, fileScope = 'shared'): void {
		scopes.set(sess, fileScope)
		trustedSessions.add(sess)
		if (installedSessions.has(sess)) return
		installedSessions.add(sess)
		try {
			sess.protocol.unhandle('difile')
		} catch {
			// Not previously registered — fine.
		}
		sess.protocol.handle('difile', difileHandler(fileScope))
	}

	const cleanup = (): void => {
		disposed = true
		unregisterConfigurator?.()
		unregisterConfigurator = null
		drainAllWaiters()
		scopedStores.clear()
		for (const sess of installedSessions) {
			try {
				sess.protocol.unhandle('difile')
			} catch {
				// May already have been unhandled by app shutdown.
			}
		}
		registry.dispose()
	}

	try {
		installOnSession(simSession)
		// Apply to every per-project miniapp partition session (current + future).
		unregisterConfigurator = registerMiniappSessionConfigurator((sess, partition) => {
			const scope = miniappFileScope(partition)
			if (!scope) throw new Error('invalid miniapp partition')
			installOnSession(sess, scope)
		})

		// Renderer FSM → main fs operations bridge. The same simulator-only sender
		// policy applies — registry instance is shared.
		registry.handle('simulator:fs:read', (event, payload) =>
			handleFsRead(payload as Parameters<typeof handleFsRead>[0], scopeFor(event.sender.session)),
		)
		registry.handle('simulator:fs:write', (event, payload) =>
			handleFsWrite(payload as Parameters<typeof handleFsWrite>[0], scopeFor(event.sender.session)),
		)
		registry.handle('simulator:fs:stat', (event, payload) =>
			handleFsStat(payload as Parameters<typeof handleFsStat>[0], scopeFor(event.sender.session)),
		)
		registry.handle('simulator:fs:readdir', (event, payload) =>
			handleFsReaddir(payload as Parameters<typeof handleFsReaddir>[0], scopeFor(event.sender.session)),
		)
		registry.handle('simulator:fs:unlink', (event, payload) =>
			handleFsUnlink(payload as Parameters<typeof handleFsUnlink>[0], scopeFor(event.sender.session)),
		)
		registry.handle('simulator:fs:mkdir', (event, payload) =>
			handleFsMkdir(payload as Parameters<typeof handleFsMkdir>[0], scopeFor(event.sender.session)),
		)
	} catch (error) {
		cleanup()
		throw error
	}

	return toDisposable(cleanup)
}
