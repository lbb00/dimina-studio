/**
 * `config.onSetup` runs host code of arbitrary, host-controlled duration.
 * Before `wireMainWindowEvents` (which wires the list window's `resize` →
 * `context.views.repositionAll()`) was moved ahead of `await setup` in
 * `app.ts`, a window resize during that window did nothing: the listener
 * was not registered yet, so mounted views could drift out of place with
 * nothing to correct them until the host hook finally resolved.
 *
 * This drives the real `createDevtoolsRuntime` with a gated `onSetup` and
 * asserts a resize while it is still pending already calls `repositionAll()`
 * — the instance is captured via `onInstanceCreated`, which fires (per its
 * own doc comment) before `onSetup` is awaited.
 */
import { describe, it, expect, vi } from 'vitest'
import { registerRuntimeTestLifecycle } from './window-close-reveal.harness.js'
import type { WorkbenchAppInstance } from './app.js'

const state = registerRuntimeTestLifecycle()

describe('main window resize while a host onSetup is still pending', () => {
  it('resize calls context.views.repositionAll() before onSetup resolves', async () => {
    let onSetupResolve!: () => void
    const onSetupGate = new Promise<void>((resolve) => { onSetupResolve = resolve })

    let captured: WorkbenchAppInstance | undefined
    const booted = state.createDevtoolsRuntime(
      { onSetup: async () => { await onSetupGate } },
      (instance) => { captured = instance },
    )

    // Drain the macrotask queue so the synchronous prefix of
    // `createDevtoolsRuntime` — window/context construction through
    // `onInstanceCreated`, `wireMainWindowEvents`, and into the still-gated
    // `onSetup` call — has run, without waiting on `onSetup` itself (which
    // this test holds open on purpose).
    await new Promise((r) => setTimeout(r, 0))

    if (!captured) throw new Error('onInstanceCreated did not fire before onSetup settled')
    const instance = captured

    const repositionSpy = vi.spyOn(instance.context.views, 'repositionAll')
    ;(instance.mainWindow as unknown as { emit: (event: string) => void }).emit('resize')

    expect(
      repositionSpy,
      'a resize during a still-pending onSetup must already reposition mounted views',
    ).toHaveBeenCalled()

    onSetupResolve()
    await booted
    await instance.dispose()
  })
})
