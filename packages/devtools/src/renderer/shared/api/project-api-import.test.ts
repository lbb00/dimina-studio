import { beforeEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({ invokeStrict: vi.fn() }))
vi.mock('./ipc-transport', () => ({ invokeStrict: transport.invokeStrict, invoke: vi.fn(), on: vi.fn() }))

import { importProject } from './project-api'
import { ProjectsChannel } from '../../../shared/ipc-channels'

const project = { name: '项目', path: '/tmp/project', lastOpened: null }

beforeEach(() => { vi.clearAllMocks() })

describe('importProject', () => {
  it('returns the structured success project', async () => {
    transport.invokeStrict.mockResolvedValueOnce({ ok: true, project })
    await expect(importProject(project.path)).resolves.toEqual(project)
    expect(transport.invokeStrict).toHaveBeenCalledWith(ProjectsChannel.Import, project.path)
  })

  it('uses the main-provided business reason without Electron wrapper text', async () => {
    transport.invokeStrict.mockResolvedValueOnce({ ok: false, reason: '缺少 app.json' })
    await expect(importProject('/tmp/broken')).rejects.toThrow('缺少 app.json')
  })

  it.each([
    ['undefined response', undefined],
    ['null response', null],
    ['success without project', { ok: true }],
    ['failure without reason', { ok: false }],
    ['string ok flag', { ok: 'true', project }],
    ['success with a non-string project path', { ok: true, project: { ...project, path: 7 } }],
  ])('converts malformed %s into a retryable error', async (_label, result) => {
    transport.invokeStrict.mockResolvedValueOnce(result)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(importProject('/tmp/broken')).rejects.toThrow('导入请求失败，请稍后重试。')
    expect(log).toHaveBeenCalledWith('[projects] import IPC failed', expect.any(Error))
  })

  it('records a rejected invoke but exposes a retryable error', async () => {
    const transportError = new Error("Error invoking remote method 'projects:import': bridge disconnected")
    transport.invokeStrict.mockRejectedValueOnce(transportError)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(importProject('/tmp/project')).rejects.toThrow('导入请求失败，请稍后重试。')
    expect(log).toHaveBeenCalledWith('[projects] import IPC failed', transportError)
  })
})
