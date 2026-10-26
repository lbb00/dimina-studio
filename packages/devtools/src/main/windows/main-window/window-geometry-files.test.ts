import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }))

beforeEach(() => {
  state.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-geometry-files-'))
  vi.resetModules()
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(state.userData, { recursive: true, force: true })
})

describe('window geometry across independent owners', () => {
  it('preserves both projects when another owner saves before the first owner publishes', async () => {
    const first = await import('./window-geometry.js')
    vi.resetModules()
    const second = await import('./window-geometry.js')
    const legacyFile = path.join(state.userData, 'dimina-window-geometry.json')
    fs.writeFileSync(legacyFile, '{}')
    const a = { x: 120, y: 80, width: 800, height: 600 }
    const b = { x: 40, y: 60, width: 900, height: 700 }
    const rename = fs.renameSync.bind(fs)
    let otherOwnerSaved = false

    // 第一份临时文件已经写好；另一进程先发布，再完成第一次原子替换。
    vi.spyOn(fs, 'renameSync').mockImplementation((...args: Parameters<typeof fs.renameSync>) => {
      if (!otherOwnerSaved) {
        otherOwnerSaved = true
        second.saveWindowGeometry('project:/b', b)
      }
      rename(...args)
    })

    first.saveWindowGeometry('project:/a', a)
    expect(otherOwnerSaved).toBe(true)
    expect(first.loadWindowGeometry('project:/a')).toEqual(a)
    expect(second.loadWindowGeometry('project:/b')).toEqual(b)
  })

  it('keeps legacy data untouched while a project migrates to its own file', async () => {
    const store = await import('./window-geometry.js')
    const legacyFile = path.join(state.userData, 'dimina-window-geometry.json')
    const oldBounds = { x: 40, y: 60, width: 800, height: 600 }
    const newBounds = { x: 120, y: 80, width: 900, height: 700 }
    const legacy = JSON.stringify({ 'project:/a': oldBounds, 'project:/b': oldBounds })
    fs.writeFileSync(legacyFile, legacy)

    expect(store.loadWindowGeometry('project:/a')).toEqual(oldBounds)
    store.saveWindowGeometry('project:/a', newBounds)

    expect(store.loadWindowGeometry('project:/a')).toEqual(newBounds)
    expect(store.loadWindowGeometry('project:/b')).toEqual(oldBounds)
    expect(fs.readFileSync(legacyFile, 'utf8')).toBe(legacy)
    const records = fs.readdirSync(path.join(state.userData, 'window-geometry'))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatch(/^[a-f0-9]{64}\.json$/)
    expect(JSON.parse(fs.readFileSync(path.join(state.userData, 'window-geometry', records[0]!), 'utf8')))
      .toEqual({ key: 'project:/a', bounds: newBounds })
  })
})
