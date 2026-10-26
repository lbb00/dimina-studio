import { describe, expect, it, vi } from 'vitest'
import { createAppServices } from './app-services.js'
import type { ProjectsProvider } from './projects/types.js'

function provider(overrides: Partial<ProjectsProvider> = {}): ProjectsProvider {
  return {
    listProjects: () => [],
    addProject(path) { return { name: path, path, lastOpened: null } },
    removeProject: () => {},
    ...overrides,
  }
}

describe('AppServices project changes', () => {
  it('notifies every live subscriber after synchronous and asynchronous writes, while preserving host method this', async () => {
    class HostProvider {
      calls = 0
      listCalls = 0
      listProjects() { this.listCalls += 1; return [] }
      addProject(path: string) {
        this.calls += 1
        return { name: path, path, lastOpened: null }
      }
      removeProject() { return Promise.resolve() }
    }
    const host = new HostProvider()
    const services = createAppServices({ projectsProvider: host })
    const first = vi.fn()
    const second = vi.fn()
    const disposeFirst = services.onProjectsChanged(first)
    services.onProjectsChanged(second)

    services.projectsProvider.addProject('/one')
    await services.projectsProvider.removeProject('/one')
    disposeFirst()
    services.projectsProvider.addProject('/two')

    services.projectsProvider.listProjects()
    expect(host.calls).toBe(2)
    expect(host.listCalls).toBe(1)
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(3)
  })

  it('does not publish a failed asynchronous write', async () => {
    const services = createAppServices({
      projectsProvider: provider({ updateLastOpened: () => Promise.reject(new Error('offline')) }),
    })
    const changed = vi.fn()
    services.onProjectsChanged(changed)

    await expect(services.projectsProvider.updateLastOpened?.('/one')).rejects.toThrow('offline')
    expect(changed).not.toHaveBeenCalled()
  })

  it('keeps a persisted mutation successful when one closed-window listener fails', () => {
    const services = createAppServices({ projectsProvider: provider() })
    const received = vi.fn()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    services.onProjectsChanged(() => { throw new Error('window is closing') })
    services.onProjectsChanged(received)

    expect(() => services.projectsProvider.addProject('/one')).not.toThrow()
    expect(received).toHaveBeenCalledTimes(1)
    expect(warning).toHaveBeenCalledWith('[projects] change listener failed:', expect.any(Error))
    warning.mockRestore()
  })
})
