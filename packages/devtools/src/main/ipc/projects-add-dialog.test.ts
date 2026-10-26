/**
 * projects:add goes through the real runtime. Electron, the filesystem, and
 * devkit come from the shared runtime mock, so idle sampling and the host-slot
 * port live on that one surface.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { stubs } from '../runtime/devtools-runtime-mock.harness.js'

// ── Lazy imports (after vi.mock('electron') is set up) ──────────────────
import { ProjectsChannel } from '../../shared/ipc-channels.js'
import { ViewChannel } from '../../shared/ipc-channels-overlays.js'
let createDevtoolsRuntime: typeof import('../app/app.js').createDevtoolsRuntime

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  ;({ createDevtoolsRuntime } = await import('../app/app.js'))
})

/**
 * Invoke a registered IPC handler the same way ipcMain.handle would. The
 * event's `sender` is the main window's webContents so it passes the
 * workbench sender-policy (isMainSender).
 */
async function invokeHandler(
  mainWebContents: { id: number; isDestroyed: () => boolean; getURL?: () => string },
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  const fn = stubs.handlers.get(channel)
  if (!fn) throw new Error(`no handler registered for '${channel}'`)
  const fakeEvent = { sender: mainWebContents }
  return await (fn as (event: unknown, ...a: unknown[]) => unknown)(fakeEvent, ...args)
}

describe('projects:add — duplicate detection dialog', () => {
  it('valid + new directory returns a Project and does not call showMessageBox', async () => {
    const dir = '/tmp/projA'
    stubs.projectsWithAppJson.add(dir) // make validateProjectDir pass
    stubs.setProjectsJson(JSON.stringify([])) // empty list

    const instance = await createDevtoolsRuntime({})
    const { dialog } = await import('electron')
    const sender = instance.mainWindow.webContents as unknown as {
      id: number
      isDestroyed: () => boolean
    }

    const result = (await invokeHandler(sender, ProjectsChannel.Add, dir)) as { path: string; type?: string }

    expect(result).toBeDefined()
    expect(result.path).toBe(dir)
    expect(vi.mocked(dialog.showMessageBox)).not.toHaveBeenCalled()
    // Importing a project whose detected type already matches the sidebar's
    // default category (miniprogram) must not throw or otherwise misbehave
    // just because the handler now always pushes a category-forced signal.
    expect(result.type).toBe('miniprogram')

    // List grew to 1.
    const persisted = JSON.parse(stubs.getProjectsJson() ?? '[]') as Array<{ path: string }>
    expect(persisted.filter((p) => p.path === dir)).toHaveLength(1)

    await instance.dispose()
  })

  it('valid + already-imported directory shows an info dialog with title 项目已存在 and does NOT add a duplicate entry', async () => {
    const dir = '/tmp/projDup'
    stubs.projectsWithAppJson.add(dir)
    stubs.setProjectsJson(JSON.stringify([]))

    const instance = await createDevtoolsRuntime({})
    const { dialog } = await import('electron')
    const sender = instance.mainWindow.webContents as unknown as {
      id: number
      isDestroyed: () => boolean
    }

    // First import — succeeds silently.
    const first = (await invokeHandler(sender, ProjectsChannel.Add, dir)) as { path: string }
    expect(first.path).toBe(dir)
    expect(vi.mocked(dialog.showMessageBox)).not.toHaveBeenCalled()

    const listAfterFirst = JSON.parse(stubs.getProjectsJson() ?? '[]') as Array<{ path: string }>
    expect(listAfterFirst.filter((p) => p.path === dir)).toHaveLength(1)

    // Second import — same path. Should surface info dialog and NOT throw.
    const second = (await invokeHandler(sender, ProjectsChannel.Add, dir)) as { path: string }

    expect(second).toBeDefined()
    expect(second.path).toBe(dir)

    expect(vi.mocked(dialog.showMessageBox)).toHaveBeenCalledTimes(1)
    // dialog.showMessageBox supports both (window, options) and (options)
    // overloads; the options object is always the last argument.
    const call = vi.mocked(dialog.showMessageBox).mock.calls[0]! as unknown as unknown[]
    const opts = call[call.length - 1] as {
      type?: string
      title?: string
      detail?: string
    }
    expect(opts.type).toBe('info')
    expect(opts.title ?? '').toContain('项目已存在')
    // The detail field should reference the offending directory so the user
    // can see what they tried to import.
    expect(opts.detail ?? '').toContain(dir)

    // The list still has exactly one entry for this path.
    const listAfterSecond = JSON.parse(stubs.getProjectsJson() ?? '[]') as Array<{ path: string }>
    expect(listAfterSecond.filter((p) => p.path === dir)).toHaveLength(1)

    await instance.dispose()
  })

  it('invalid directory (no app.json) throws and shows an error dialog with title 无法导入项目', async () => {
    const dir = '/tmp/projInvalid'
    // Deliberately do NOT add to projectsWithAppJson — validateProjectDir fails.
    stubs.setProjectsJson(JSON.stringify([]))

    const instance = await createDevtoolsRuntime({})
    const { dialog } = await import('electron')
    const sender = instance.mainWindow.webContents as unknown as {
      id: number
      isDestroyed: () => boolean
    }

    let caught: unknown
    try {
      await invokeHandler(sender, ProjectsChannel.Add, dir)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()

    // Find the error dialog among (possibly multiple) showMessageBox calls.
    // The handler is allowed to also surface non-fatal warnings (e.g. an
    // unparseable project.config.json) before throwing — what we care about
    // is that the user gets exactly one error dialog with the expected title.
    expect(vi.mocked(dialog.showMessageBox).mock.calls.length).toBeGreaterThan(0)
    const errorCalls = vi.mocked(dialog.showMessageBox).mock.calls
      .map((call) => (call as unknown as unknown[])[(call as unknown as unknown[]).length - 1] as {
        type?: string
        title?: string
      })
      .filter((opts) => opts.type === 'error')
    expect(errorCalls).toHaveLength(1)
    expect(errorCalls[0]!.title).toBe('无法导入项目')

    // Persisted list is unchanged.
    const list = JSON.parse(stubs.getProjectsJson() ?? '[]') as Array<{ path: string }>
    expect(list.filter((p) => p.path === dir)).toHaveLength(0)

    await instance.dispose()
  })
})

describe('projects:add — cross-category import forces sidebar + list category', () => {
  it('importing a mini-game project pushes "minigame" through both the list-filter notify and the sidebar rail channel', async () => {
    const dir = '/tmp/projGame'
    // game.json + game.js present, app.json absent → detectRuntimeType's
    // fallback path classifies this as a mini-game.
    stubs.projectsWithMinigameFiles.add(dir)
    stubs.setProjectsJson(JSON.stringify([]))

    const instance = await createDevtoolsRuntime({})
    const sender = instance.mainWindow.webContents as unknown as {
      id: number
      isDestroyed: () => boolean
    }

    // The sidebar's default content already started loading during runtime
    // setup (`context.views.hostSidebar.loadFile(...)` in app.ts), but
    // `hostSidebar.send(...)` gates on a completed `did-finish-load`
    // handshake — replay that event on the sidebar's own webContents so the
    // real MessagePort channel goes live, the same way Chromium would once
    // the page actually finishes loading.
    const sidebarWc = instance.context.views.hostSidebar.webContents as unknown as {
      emit: (event: string) => void
    } | null
    expect(sidebarWc).toBeTruthy()
    sidebarWc!.emit('did-finish-load')
    expect(stubs.messageChannels).toHaveLength(1)

    const result = (await invokeHandler(sender, ProjectsChannel.Add, dir)) as {
      path: string
      type?: string
    }

    // Confirm the detection path itself before trusting the two forced-category
    // assertions below.
    expect(result.path).toBe(dir)
    expect(result.type).toBe('minigame')

    // 1) Main-window list filter: `ctx.notify.hostSidebarCategorySelected('minigame')`
    // ultimately does `mainWindow.webContents.send(ViewChannel.HostSidebarCategorySelected, 'minigame')`.
    const mainSendCalls = vi.mocked(instance.mainWindow.webContents.send).mock.calls
    const categoryCall = mainSendCalls.find(
      (call) => call[0] === ViewChannel.HostSidebarCategorySelected,
    )
    expect(categoryCall?.[1]).toBe('minigame')

    // 2) Sidebar rail highlight: `ctx.views.hostSidebar.send('project-category-forced', …)`
    // delivers `{ channel, payload }` over the live MessagePortMain (port1).
    const port1 = stubs.messageChannels[0]!.port1
    const forcedCalls = vi
      .mocked(port1.postMessage)
      .mock.calls.filter(
        (call) => (call[0] as { channel?: string } | undefined)?.channel === 'project-category-forced',
      )
    expect(forcedCalls).toHaveLength(1)
    expect(forcedCalls[0]![0]).toEqual({
      channel: 'project-category-forced',
      payload: { category: 'minigame' },
    })

    await instance.dispose()
  })
})
