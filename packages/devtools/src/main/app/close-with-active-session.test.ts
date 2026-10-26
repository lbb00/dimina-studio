/**
 * Behavior tests for a workbench window's `close` event while its project
 * session is active.
 *
 * Contract under test:
 *  - `event.preventDefault()` is called, so teardown finishes before the
 *    window goes away.
 *  - The project session is torn down — `workspace.hasActiveSession()` is
 *    false afterwards.
 *  - That one window is destroyed; the project-list window and the
 *    application survive.
 *  - Every IPC handler the application and the list window were serving
 *    beforehand is STILL registered afterwards. The regression we guard
 *    against: a previous implementation disposed the whole IPC registry on
 *    close, leaving a live renderer with no handlers behind it (the Import
 *    button silently broke).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getStubs, getDevkitStubs } from './close-with-active-session.harness.js'

const stubs = getStubs()
const devkitStubs = getDevkitStubs()

// ── Lazy imports ────────────────────────────────────────────────────────
import { ProjectsChannel } from '../../shared/ipc-channels.js'
let createDevtoolsRuntime: typeof import('./app.js').createDevtoolsRuntime

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  devkitStubs.sessionClose.mockClear()
  ;({ createDevtoolsRuntime } = await import('./app.js'))
})

type Instance = Awaited<ReturnType<typeof createDevtoolsRuntime>>
type ProjectWindow = ReturnType<Instance['projectWindows']>[number]

/** Opens `dir` in its own workbench window and returns that window's record. */
async function openWorkbenchWindow(instance: Instance, dir: string): Promise<ProjectWindow> {
  await instance.openProjectWindow({ path: dir })
  const [projectWindow] = instance.projectWindows()
  expect(projectWindow, 'openProjectWindow must publish the window it opened').toBeTruthy()
  return projectWindow!
}

function emitClose(win: unknown, fakeEvent: unknown) {
  ;(win as { emit: (event: string, ...args: unknown[]) => void }).emit('close', fakeEvent)
}

describe('workbench window close while its project session is active', () => {
  it('calls event.preventDefault, tears down the session, and destroys that window only', async () => {
    const projectDir = '/tmp/projActive'
    stubs.projectsWithAppJson.add(projectDir)
    stubs.setProjectsJson(JSON.stringify([]))

    const instance = await createDevtoolsRuntime({})
    const projectWindow = await openWorkbenchWindow(instance, projectDir)

    // Open the project directly through the window's workspace service.
    // Bypasses the IPC layer because what we want to set up is "a session
    // exists behind this window".
    const openResult = await projectWindow.context.workspace.openProject(projectDir)
    expect(openResult.success).toBe(true)
    expect(projectWindow.context.workspace.hasActiveSession()).toBe(true)

    const destroySpy = vi.mocked(projectWindow.window.destroy)
    const listDestroySpy = vi.mocked(instance.mainWindow.destroy)
    destroySpy.mockClear()
    listDestroySpy.mockClear()

    // Build a fake close event that records preventDefault calls.
    let prevented = 0
    const fakeEvent = {
      preventDefault: () => {
        prevented += 1
      },
    }

    // Fire the close event the same way Electron would.
    emitClose(projectWindow.window, fakeEvent)

    // The close handler is fire-and-forget (returns void); wait for the
    // full sequence (session teardown, then the window going away) to settle.
    await vi.waitFor(
      () => {
        expect(projectWindow.context.workspace.hasActiveSession()).toBe(false)
        expect(destroySpy).toHaveBeenCalledTimes(1)
      },
      { timeout: 2000 },
    )

    expect(prevented).toBe(1)
    expect(
      listDestroySpy,
      'closing one project must not take the project list down with it',
    ).not.toHaveBeenCalled()
    expect(instance.mainWindow.isDestroyed()).toBe(false)

    await instance.dispose()
  })

  it('does NOT unregister the app-level IPC handlers — every channel the list window was served by is still active afterwards', async () => {
    const projectDir = '/tmp/projActiveKeepHandlers'
    stubs.projectsWithAppJson.add(projectDir)
    stubs.setProjectsJson(JSON.stringify([]))

    const instance = await createDevtoolsRuntime({})

    // Snapshot the live handler set BEFORE any workbench window exists: this
    // is exactly the surface the application and the project-list window own,
    // and all of it must outlive a workbench window's close. We include the
    // critical channels by name explicitly so a regression that drops *only
    // one* still fails this test.
    const liveBefore = new Set(stubs.handlers.keys())
    const criticalChannels = [
      ProjectsChannel.List,
      ProjectsChannel.Add,
      'dialog:openDirectory',
    ]
    for (const ch of criticalChannels) {
      expect(
        liveBefore.has(ch),
        `precondition: channel '${ch}' should be registered before close`,
      ).toBe(true)
    }

    const projectWindow = await openWorkbenchWindow(instance, projectDir)
    await projectWindow.context.workspace.openProject(projectDir)
    expect(projectWindow.context.workspace.hasActiveSession()).toBe(true)

    const removeHandlerCallsBefore = stubs.removeHandlerCalls.length
    const destroySpy = vi.mocked(projectWindow.window.destroy)
    destroySpy.mockClear()

    // Fire the close event.
    const fakeEvent = { preventDefault: () => {} }
    emitClose(projectWindow.window, fakeEvent)

    // Wait for the close handler to fully resolve (session teardown is async,
    // and the window is destroyed only once it finishes).
    await vi.waitFor(
      () => {
        expect(projectWindow.context.workspace.hasActiveSession()).toBe(false)
        expect(destroySpy).toHaveBeenCalledTimes(1)
      },
      { timeout: 2000 },
    )

    // Every channel that was live before the workbench window existed must
    // still be live.
    const liveAfter = new Set(stubs.handlers.keys())
    for (const ch of liveBefore) {
      expect(
        liveAfter.has(ch),
        `expected channel '${ch}' to remain registered after a workbench window closed`,
      ).toBe(true)
    }

    // Specifically the channels the import flow relies on must not have been
    // unregistered. (`removeHandler` would push to removeHandlerCalls.)
    const removedDuringClose = stubs.removeHandlerCalls.slice(
      removeHandlerCallsBefore,
    )
    for (const ch of criticalChannels) {
      expect(
        removedDuringClose.includes(ch),
        `removeHandler('${ch}') must NOT be called during close — that's the regression we're guarding`,
      ).toBe(false)
    }

    await instance.dispose()
  })
})

/**
 * LEAK-PROOFING WAVE (项目关闭时保证编译子进程同步关闭) — app/registry
 * teardown conduction.
 *
 * `instance.dispose()` (the path hosts and tests run at app shutdown) must
 * tear down every open workbench window's ACTIVE SESSION, not just the IPC
 * registry. The session's close() is the only hop that reaches devkit and
 * kills the forked compile worker — an app teardown that skips it leaks one
 * compiler process per shutdown-with-open-project.
 *
 * Workspace-level conduction (closeProject → session.close, open-switch,
 * rejecting close) is pinned in
 * `services/workspace/workspace-session-teardown.test.ts`; this describe
 * pins the one hop above it: dispose → closeProject → session.close.
 */
describe('instance.dispose() while a project session is active (app teardown leak guard)', () => {
  it('dispose() closes the workbench window\'s active devkit session exactly once and clears it', async () => {
    const projectDir = '/tmp/projDisposeActive'
    stubs.projectsWithAppJson.add(projectDir)
    stubs.setProjectsJson(JSON.stringify([]))

    const instance = await createDevtoolsRuntime({})
    const projectWindow = await openWorkbenchWindow(instance, projectDir)
    const openResult = await projectWindow.context.workspace.openProject(projectDir)
    expect(openResult.success).toBe(true)
    expect(projectWindow.context.workspace.hasActiveSession()).toBe(true)
    // The open itself must not have closed anything (a fresh service's
    // pre-open disposeSession is a no-op) — baseline for the pin below.
    expect(devkitStubs.sessionClose).not.toHaveBeenCalled()

    await instance.dispose()

    expect(
      devkitStubs.sessionClose,
      'instance.dispose() must close the active session — this is the hop that kills the forked '
      + 'compile worker; disposing only the IPC registry leaks one compiler process per app shutdown',
    ).toHaveBeenCalledTimes(1)
    expect(projectWindow.context.workspace.hasActiveSession()).toBe(false)
  })

  it('dispose() with no active session does not invent a session close (and stays idempotent after a real one)', async () => {
    const projectDir = '/tmp/projDisposeIdempotent'
    stubs.projectsWithAppJson.add(projectDir)
    stubs.setProjectsJson(JSON.stringify([]))

    const instance = await createDevtoolsRuntime({})
    const projectWindow = await openWorkbenchWindow(instance, projectDir)
    await projectWindow.context.workspace.openProject(projectDir)

    await instance.dispose()
    expect(devkitStubs.sessionClose).toHaveBeenCalledTimes(1)

    // A second dispose (host teardown re-entry) must not double-close the
    // already-dead session.
    await instance.dispose()
    expect(
      devkitStubs.sessionClose,
      'double dispose must not double-close the session',
    ).toHaveBeenCalledTimes(1)
  })
})
