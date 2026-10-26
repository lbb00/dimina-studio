/**
 * UpdateManager CONSTRUCTION TIMING RELATIVE TO onSetup.
 *
 * `UpdateManager` only depends on `config`/`projectList`/`context` — none of
 * which `onSetup` produces — so it has no functional need to exist before
 * `onSetup` resolves. Its constructor starts a periodic update-check timer
 * (default 5s initial delay) that can pop an update dialog via
 * `projectList.showUpdate`; building it while a host `onSetup` of unbounded
 * duration is still configuring the app risks that dialog appearing before
 * the host is done. It must be constructed only after `await setup`.
 */
import { describe, it, expect, vi } from 'vitest'
import { registerRuntimeTestLifecycle } from './window-close-reveal.harness.js'
import type { WorkbenchAppInstance } from './app.js'

const state = registerRuntimeTestLifecycle()

describe('UpdateManager construction relative to onSetup', () => {
  it('does not exist while onSetup is still pending, and exists once it resolves', async () => {
    let onSetupResolve!: () => void
    const onSetupGate = new Promise<void>((resolve) => { onSetupResolve = resolve })

    let captured: WorkbenchAppInstance | undefined
    const booted = state.createDevtoolsRuntime(
      {
        updateChecker: {
          checkForUpdates: vi.fn(async () => null),
          downloadUpdate: vi.fn(async () => ''),
        },
        // Large enough that the periodic check's own timer can't fire and
        // interfere with this test or leak past it.
        updateOptions: { initialDelay: 999_999_999 },
        onSetup: async () => { await onSetupGate },
      },
      (instance) => { captured = instance },
    )

    // Drain the synchronous prefix (through `onInstanceCreated`) without
    // waiting on the still-gated `onSetup`.
    await new Promise((r) => setTimeout(r, 0))

    if (!captured) throw new Error('onInstanceCreated did not fire before onSetup settled')
    expect(
      captured.updateManager,
      'UpdateManager must not be constructed while a host onSetup of unbounded duration is still running',
    ).toBeUndefined()

    onSetupResolve()
    const instance = await booted

    expect(
      instance.updateManager,
      'UpdateManager must be constructed once onSetup has resolved',
    ).toBeDefined()

    await instance.dispose()
  })
})
