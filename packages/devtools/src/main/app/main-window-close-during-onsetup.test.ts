/**
 * MAIN WINDOW CLOSED WHILE onSetup IS STILL PENDING.
 *
 * `wireMainWindowEvents` (list-window close guard) is now registered before
 * `await setup` (see `main-window-resize-during-onsetup.test.ts`), so a user
 * can close the list window while a host `onSetup` of unbounded duration is
 * still running. With no project window open, that close is NOT intercepted:
 * `launcher.dispose()` tears the window's context down and Electron's
 * default behaviour destroys the native window. `onSetup` itself keeps
 * running independently and eventually resolves regardless.
 *
 * Automation and MCP are wired up unconditionally once `await setup`
 * settles — they must not attach to an instance whose window/context are
 * already gone, or an external client ends up driving a dead window.
 */
import { describe, it, expect, vi } from 'vitest'

const serversMock = vi.hoisted(() => ({
  setupAutomation: vi.fn(async () => null),
  setupMcp: vi.fn(() => null),
}))
vi.mock('./servers.js', () => serversMock)

import { registerRuntimeTestLifecycle, makeCloseEvent, emitClose } from './window-close-reveal.harness.js'
import type { WorkbenchAppInstance } from './app.js'

const state = registerRuntimeTestLifecycle()

describe('main window closed while a host onSetup is still pending', () => {
  it('does not wire automation/MCP once onSetup resolves after the window was closed with no project open', async () => {
    serversMock.setupAutomation.mockClear()
    serversMock.setupMcp.mockClear()

    let onSetupResolve!: () => void
    const onSetupGate = new Promise<void>((resolve) => { onSetupResolve = resolve })

    let captured: WorkbenchAppInstance | undefined
    const booted = state.createDevtoolsRuntime(
      { onSetup: async () => { await onSetupGate } },
      (instance) => { captured = instance },
    )

    // Drain the synchronous prefix (through `wireMainWindowEvents`) without
    // waiting on the still-gated `onSetup`.
    await new Promise((r) => setTimeout(r, 0))

    if (!captured) throw new Error('onInstanceCreated did not fire before onSetup settled')
    const instance = captured
    expect(instance.projectWindows().length, 'setup: no project window must be open').toBe(0)

    const { event } = makeCloseEvent()
    emitClose(instance.mainWindow, event)
    await new Promise((r) => setTimeout(r, 0))
    // Real Electron destroys the native window once its 'close' isn't
    // prevented; the mock doesn't do this on its own, so simulate the
    // follow-through the close handler's `void launcher.dispose()` implies.
    ;(instance.mainWindow as unknown as { destroy: () => void }).destroy()
    expect(instance.mainWindow.isDestroyed(), 'setup: window must be destroyed before onSetup resolves').toBe(true)

    onSetupResolve()
    await booted

    expect(
      serversMock.setupAutomation,
      'automation must not be wired up against a window/context that no longer exists',
    ).not.toHaveBeenCalled()
    expect(
      serversMock.setupMcp,
      'MCP must not be wired up against a window/context that no longer exists',
    ).not.toHaveBeenCalled()
  })
})
