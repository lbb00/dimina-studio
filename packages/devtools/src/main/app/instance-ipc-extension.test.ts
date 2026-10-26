/**
 * Workbench model refactor — "custom IPC extension surface".
 *
 * The `onSetup(instance)` hook hands the host a `WorkbenchAppInstance`. This
 * suite pins down two NEW capabilities that surface object must grow
 * (`docs/library-integration.md`):
 *
 *  Requirement A — `instance.ipc`:
 *    A gated `IpcRegistry` bound to `context.senderPolicy`. Channels
 *    registered through it reject untrusted senders (gateway parity with the
 *    built-in IPC), accept trusted ones, and are torn down when the context
 *    is disposed (the registry lives in `ctx.registry`).
 *
 *  Requirement B — `instance.registerTrustedWindow(win)`:
 *    Adds a host-owned BrowserWindow's webContents to the trusted-sender set
 *    so `context.senderPolicy(win.webContents)` returns true. The returned
 *    Disposable removes it again; closing the window auto-removes it; and the
 *    Disposable is registered into `ctx.registry` for context-scoped cleanup.
 *
 * Each assertion below pins one of these two capabilities. A failure must
 * point at the feature itself (`instance.ipc` / `instance.registerTrustedWindow`
 * undefined, or the policy not honoring a registered window), not at a broken
 * harness.
 *
 * Seam: there is no standalone factory for `WorkbenchAppInstance` — the
 * object is built inline inside `createDevtoolsRuntime()`. The closest
 * stable seam is the `onSetup` hook itself, which receives that very
 * instance. We drive the full app under the same exhaustive electron mock
 * used by `update-manager-sender-policy.test.ts` and capture the instance
 * from `onSetup`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getStubs } from './instance-ipc-extension.harness.js'

const stubs = getStubs()

// Imported lazily inside beforeEach so the electron mock is installed before
// app.ts (and its transitive module graph) captures `ipcMain` / `app`.
let createDevtoolsRuntime: typeof import('./app.js').createDevtoolsRuntime
let IpcRegistry: typeof import('../utils/ipc-registry.js').IpcRegistry
let BrowserWindowMock: typeof import('electron').BrowserWindow

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  ;({ createDevtoolsRuntime } = await import('./app.js'))
  ;({ IpcRegistry } = await import('../utils/ipc-registry.js'))
  ;({ BrowserWindow: BrowserWindowMock } = await import('electron'))
})

/**
 * Drives `createDevtoolsRuntime` and returns the `WorkbenchAppInstance` captured
 * from the `onSetup` hook — the runtime object whose extension surface this
 * suite verifies.
 */
async function setupInstance(): Promise<import('./app.js').WorkbenchAppInstance> {
  let captured: import('./app.js').WorkbenchAppInstance | undefined
  const instance = await createDevtoolsRuntime({
    onSetup(inst) {
      captured = inst as import('./app.js').WorkbenchAppInstance
    },
  })
  // `onSetup` runs synchronously inside setup(); if it didn't capture, the
  // hook contract itself regressed.
  expect(captured, 'onSetup must receive the WorkbenchAppInstance').toBeDefined()
  // The captured instance and the returned instance are the same object.
  expect(captured).toBe(instance)
  return instance
}

/** A WebContents-shaped object the workbench sender-policy will NOT trust. */
function untrustedSender() {
  return { id: 987_654, isDestroyed: () => false, getURL: () => 'https://evil.example' }
}

// ── Requirement A — instance.ipc ────────────────────────────────────────────

describe('Requirement A: instance.ipc is a gated IpcRegistry', () => {
  it('exposes `ipc` as an IpcRegistry instance on the onSetup instance', async () => {
    const instance = await setupInstance()

    // Catches "instance.ipc was never added".
    expect(
      (instance as unknown as { ipc?: unknown }).ipc,
      'expected instance.ipc to be defined',
    ).toBeDefined()
    // Catches "instance.ipc is some ad-hoc object, not an IpcRegistry".
    expect((instance as unknown as { ipc: unknown }).ipc).toBeInstanceOf(IpcRegistry)
    expect(
      typeof (instance as unknown as { ipc: { handle?: unknown } }).ipc.handle,
    ).toBe('function')

    await instance.dispose()
  })

  it('a channel registered via instance.ipc rejects an untrusted sender', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const instance = await setupInstance()
    const ipc = (instance as unknown as { ipc: InstanceType<typeof IpcRegistry> }).ipc

    ipc.handle('host:custom-ipc', () => 'host-data')

    const guarded = stubs.ipcHandlers.get('host:custom-ipc')
    expect(guarded, 'instance.ipc.handle must register the channel on ipcMain').toBeDefined()

    // instance.ipc is bound to ctx.senderPolicy → an untrusted sender must be
    // rejected with the IpcRegistry gate's rejection. Without the policy
    // binding the handler would run ungated and resolve to 'host-data'.
    await expect(
      Promise.resolve(guarded!({ sender: untrustedSender() })),
    ).rejects.toThrow(/IPC sender rejected for channel host:custom-ipc/)

    warnSpy.mockRestore()
    await instance.dispose()
  })

  it('a channel registered via instance.ipc accepts the trusted main-window sender', async () => {
    const instance = await setupInstance()
    const ipc = (instance as unknown as { ipc: InstanceType<typeof IpcRegistry> }).ipc

    ipc.handle('host:custom-ipc-ok', () => 'host-data')
    const guarded = stubs.ipcHandlers.get('host:custom-ipc-ok')!

    // The main window's renderer IS on the default trusted set; a call from it
    // must pass the gate and return the handler's value.
    const mainSender = instance.mainWindow.webContents
    await expect(
      Promise.resolve(guarded({ sender: mainSender })),
    ).resolves.toBe('host-data')

    await instance.dispose()
  })

  it('handlers registered via instance.ipc are torn down when the context is disposed', async () => {
    const instance = await setupInstance()
    const ipc = (instance as unknown as { ipc: InstanceType<typeof IpcRegistry> }).ipc

    ipc.handle('host:disposed-ipc', () => 'x')
    expect(stubs.ipcHandlers.has('host:disposed-ipc')).toBe(true)

    // instance.ipc must live inside ctx.registry, so disposing the context
    // (instance.dispose → ctx.registry.dispose) cascades to removeHandler.
    await instance.dispose()

    expect(
      stubs.removeHandlerCalls,
      "expected ctx dispose to removeHandler('host:disposed-ipc') — instance.ipc must be in ctx.registry",
    ).toContain('host:disposed-ipc')
    expect(stubs.ipcHandlers.has('host:disposed-ipc')).toBe(false)
  })
})

// ── Requirement B — instance.registerTrustedWindow ──────────────────────────

describe('Requirement B: instance.registerTrustedWindow', () => {
  it('exposes `registerTrustedWindow` as a function on the onSetup instance', async () => {
    const instance = await setupInstance()
    expect(
      typeof (instance as unknown as { registerTrustedWindow?: unknown }).registerTrustedWindow,
    ).toBe('function')
    await instance.dispose()
  })

  it('an unregistered host window is NOT trusted by the sender policy', async () => {
    const instance = await setupInstance()
    const hostWin = new BrowserWindowMock()

    // A fresh host BrowserWindow is not the main window / settings / overlay,
    // so the default policy must reject it.
    expect(
      instance.context.senderPolicy(hostWin.webContents),
      'a host window must be untrusted before registerTrustedWindow',
    ).toBe(false)

    await instance.dispose()
  })

  it('registerTrustedWindow(win) makes win.webContents trusted', async () => {
    const instance = await setupInstance()
    const hostWin = new BrowserWindowMock()
    const reg = instance as unknown as {
      registerTrustedWindow: (w: import('electron').BrowserWindow) => import('electron-deck/main').Disposable
    }

    expect(instance.context.senderPolicy(hostWin.webContents)).toBe(false)

    reg.registerTrustedWindow(hostWin)

    // After registration the same webContents must pass the gate.
    expect(
      instance.context.senderPolicy(hostWin.webContents),
      'registerTrustedWindow must add win.webContents to the trusted set',
    ).toBe(true)

    await instance.dispose()
  })

  it('disposing the returned Disposable un-trusts the window again', async () => {
    const instance = await setupInstance()
    const hostWin = new BrowserWindowMock()
    const reg = instance as unknown as {
      registerTrustedWindow: (w: import('electron').BrowserWindow) => import('electron-deck/main').Disposable
    }

    const disposable = reg.registerTrustedWindow(hostWin)
    expect(instance.context.senderPolicy(hostWin.webContents)).toBe(true)
    expect(
      typeof disposable?.dispose,
      'registerTrustedWindow must return a Disposable',
    ).toBe('function')

    await disposable.dispose()

    expect(
      instance.context.senderPolicy(hostWin.webContents),
      'disposing the returned Disposable must remove the window from the trusted set',
    ).toBe(false)

    await instance.dispose()
  })

  it("auto-removes the window from the trusted set when it emits 'closed'", async () => {
    const instance = await setupInstance()
    const hostWin = new BrowserWindowMock()
    const reg = instance as unknown as {
      registerTrustedWindow: (w: import('electron').BrowserWindow) => import('electron-deck/main').Disposable
    }

    reg.registerTrustedWindow(hostWin)
    expect(instance.context.senderPolicy(hostWin.webContents)).toBe(true)

    // Host closes its own dialog without calling dispose() — the window's
    // 'closed' event must auto-evict it from the trusted set.
    ;(hostWin as unknown as { emit: (e: string) => void }).emit('closed')

    expect(
      instance.context.senderPolicy(hostWin.webContents),
      "a closed host window must no longer be trusted (auto-cleanup on 'closed')",
    ).toBe(false)

    await instance.dispose()
  })

  it('the registerTrustedWindow Disposable is in ctx.registry — context dispose un-trusts the window', async () => {
    const instance = await setupInstance()
    const hostWin = new BrowserWindowMock()
    const reg = instance as unknown as {
      registerTrustedWindow: (w: import('electron').BrowserWindow) => import('electron-deck/main').Disposable
    }

    reg.registerTrustedWindow(hostWin)
    expect(instance.context.senderPolicy(hostWin.webContents)).toBe(true)

    // Without ever calling the returned disposable, disposing the context
    // must still un-trust the window — proof the disposable joined
    // ctx.registry and is released by the context-scoped cascade.
    await instance.dispose()

    expect(
      instance.context.senderPolicy(hostWin.webContents),
      'context dispose must release the registerTrustedWindow disposable (it must live in ctx.registry)',
    ).toBe(false)
  })

  // ── Reference-counting semantics for repeated registration ────────────────
  //
  // `trustedWindowSenderIds` is a `Map<number, number>` keyed on
  // `webContents.id` whose value is a reference count, so registering the SAME
  // window twice bumps the count to 2 under a single key. A naive
  // implementation that just `map.delete(id)` on dispose lets the FIRST
  // dispose evict the window even though a second, still-live registration
  // exists. The trusted state must be reference-counted: the entry survives
  // until EVERY registration's Disposable has been disposed (count → 0).

  it('registering the same window twice keeps it trusted until BOTH disposables are disposed', async () => {
    const instance = await setupInstance()
    const hostWin = new BrowserWindowMock()
    const reg = instance as unknown as {
      registerTrustedWindow: (w: import('electron').BrowserWindow) => import('electron-deck/main').Disposable
    }

    const first = reg.registerTrustedWindow(hostWin)
    const second = reg.registerTrustedWindow(hostWin)

    // Two registrations → trusted.
    expect(
      instance.context.senderPolicy(hostWin.webContents),
      'a window registered twice must be trusted',
    ).toBe(true)

    // Dispose ONE of the two registrations. The other is still live, so the
    // window MUST remain trusted. (A non-ref-counted impl fails here: the
    // first dispose deletes the shared Set entry and the window goes dark
    // while `second` is still holding a reference.)
    await first.dispose()
    expect(
      instance.context.senderPolicy(hostWin.webContents),
      'disposing one of two registrations must NOT un-trust the window — the other registration is still live',
    ).toBe(true)

    // Dispose the LAST registration → ref-count hits zero → un-trusted.
    await second.dispose()
    expect(
      instance.context.senderPolicy(hostWin.webContents),
      'disposing the final registration must un-trust the window',
    ).toBe(false)
  })

  it("a window registered twice is un-trusted immediately on 'closed', regardless of outstanding disposables", async () => {
    const instance = await setupInstance()
    const hostWin = new BrowserWindowMock()
    const reg = instance as unknown as {
      registerTrustedWindow: (w: import('electron').BrowserWindow) => import('electron-deck/main').Disposable
    }

    reg.registerTrustedWindow(hostWin)
    reg.registerTrustedWindow(hostWin)
    expect(instance.context.senderPolicy(hostWin.webContents)).toBe(true)

    // The window is gone — `closed` must zero the ref-count outright. It must
    // NOT take two `closed` events (one per registration) to evict it; the
    // window is dead, so a single `closed` un-trusts it even though neither
    // Disposable was disposed.
    ;(hostWin as unknown as { emit: (e: string) => void }).emit('closed')

    expect(
      instance.context.senderPolicy(hostWin.webContents),
      "'closed' must un-trust a twice-registered window in one shot — the window is dead, ref-count goes straight to zero",
    ).toBe(false)
  })

  it("after one dispose + 'closed' on a twice-registered window, disposing the remaining disposable is a safe no-op", async () => {
    const instance = await setupInstance()
    const hostWin = new BrowserWindowMock()
    const reg = instance as unknown as {
      registerTrustedWindow: (w: import('electron').BrowserWindow) => import('electron-deck/main').Disposable
    }

    const first = reg.registerTrustedWindow(hostWin)
    const second = reg.registerTrustedWindow(hostWin)
    expect(instance.context.senderPolicy(hostWin.webContents)).toBe(true)

    // Dispose one registration, then close the window. The window is dead and
    // there is still one outstanding registration (`second`) that was never
    // disposed.
    await first.dispose()
    ;(hostWin as unknown as { emit: (e: string) => void }).emit('closed')
    expect(
      instance.context.senderPolicy(hostWin.webContents),
      "'closed' must un-trust the window even with an outstanding registration",
    ).toBe(false)

    // Disposing the leftover registration after the window already closed must
    // not throw and must not resurrect / mis-decrement anything.
    await expect(Promise.resolve(second.dispose())).resolves.not.toThrow()
    expect(
      instance.context.senderPolicy(hostWin.webContents),
      'window stays un-trusted after disposing the leftover registration post-close',
    ).toBe(false)
  })

  // ── App-level ownership: the trusted-sender ledger outlives any one window's
  // context, so `registerTrustedWindow`'s Disposable is tracked at the app
  // level rather than in `ctx.registry`. What must hold regardless of WHERE
  // the bookkeeping lives is the observable IPC contract: a channel gated by
  // `context.senderPolicy` (the same gate the built-in workbench IPC surface
  // uses) accepts the window while registered and rejects it — with the
  // IpcRegistry gate's own rejection — once disposed, and a second dispose is
  // a safe no-op rather than resurrecting trust or throwing.

  it('registerTrustedWindow(win) is accepted by a senderPolicy-gated IPC channel until disposed, and dispose is idempotent', async () => {
    const instance = await setupInstance()
    const hostWin = new BrowserWindowMock()
    const reg = instance as unknown as {
      registerTrustedWindow: (w: import('electron').BrowserWindow) => import('electron-deck/main').Disposable
    }

    // Same gate shape the built-in workbench IPC surface uses (see e.g.
    // automation/index.ts's `new IpcRegistry((sender) => getCtx().senderPolicy(sender))`).
    const gated = new IpcRegistry((sender) => instance.context.senderPolicy(sender))
    gated.handle('host:trust-gate', () => 'trusted-data')
    const guarded = stubs.ipcHandlers.get('host:trust-gate')!

    const disposable = reg.registerTrustedWindow(hostWin)

    // Registered: the gate resolves the channel for this window's sender.
    await expect(
      Promise.resolve(guarded({ sender: hostWin.webContents })),
      'a registered window must be accepted by a senderPolicy-gated channel',
    ).resolves.toBe('trusted-data')

    await disposable.dispose()

    // Disposed: the same sender is rejected, with the IpcRegistry gate's own
    // rejection message (not a generic thrown/falsy value).
    await expect(
      Promise.resolve(guarded({ sender: hostWin.webContents })),
      'a disposed registration must be rejected by the senderPolicy gate',
    ).rejects.toThrow('IPC sender rejected for channel host:trust-gate')

    // Idempotent: a second dispose must not throw, and must not resurrect trust.
    await expect(
      Promise.resolve(disposable.dispose()),
      'disposing an already-disposed registration must be a safe no-op',
    ).resolves.not.toThrow()
    await expect(
      Promise.resolve(guarded({ sender: hostWin.webContents })),
    ).rejects.toThrow('IPC sender rejected for channel host:trust-gate')

    await instance.dispose()
  })
})
