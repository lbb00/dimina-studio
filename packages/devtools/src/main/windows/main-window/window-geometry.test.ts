import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  windows: [] as Array<{ options: Record<string, unknown>, emit: (event: string) => void, bounds: { x: number, y: number, width: number, height: number }, normalBounds: { x: number, y: number, width: number, height: number }, maximized: boolean, fullscreen: boolean }>,
  workArea: { x: 0, y: 0, width: 1440, height: 900 },
  failWrite: false,
  failRename: false,
  failRead: false,
  matchingWorkArea: undefined as { x: number, y: number, width: number, height: number } | undefined,
  nativeReadCount: 0,
  shownCount: 0,
  shownInactiveCount: 0,
}))

vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs')
  const mocked = {
    ...real,
    readFileSync: vi.fn((file: string) => {
      if (state.failRead) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      const value = state.files.get(file)
      if (value === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return value
    }),
    writeFileSync: vi.fn((file: string, value: string) => {
      if (state.failWrite) throw new Error('write failed')
      state.files.set(file, value)
    }),
    renameSync: vi.fn((from: string, to: string) => {
      if (state.failRename) throw new Error('rename failed')
      const value = state.files.get(from)
      if (value === undefined) throw new Error('ENOENT')
      state.files.delete(from)
      state.files.set(to, value)
    }),
    unlinkSync: vi.fn((file: string) => state.files.delete(file)),
  }
  return { ...mocked, default: mocked }
})

vi.mock('electron', async () => {
  const { createTestScreen } = await import('../../test-support/electron-screen.js')
  class WebContents {
    on = vi.fn()
    setWindowOpenHandler = vi.fn()
    loadFile = vi.fn(() => Promise.resolve())
  }
  class View { addChildView = vi.fn() }
  class WebContentsView extends View { webContents = new WebContents() }
  class BrowserWindow {
    listeners = new Map<string, Array<() => void>>()
    options: Record<string, unknown>
    bounds: { x: number, y: number, width: number, height: number }
    normalBounds: { x: number, y: number, width: number, height: number }
    maximized = false
    fullscreen = false
    destroyed = false
    webContents = new WebContents()
    contentView: View | WebContentsView = new WebContentsView()
    constructor(options: Record<string, unknown>) {
      this.options = options
      this.bounds = options as typeof this.bounds
      this.normalBounds = { ...this.bounds }
      state.windows.push(this)
    }
    once(event: string, listener: () => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]) }
    on(event: string, listener: () => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]) }
    emit(event: string) {
      if (event === 'closed') this.destroyed = true
      for (const listener of this.listeners.get(event) ?? []) listener()
    }
    getBounds = () => this.assertAlive(this.bounds)
    getNormalBounds = () => this.assertAlive(this.normalBounds)
    isMaximized = () => this.assertAlive(this.maximized)
    isFullScreen = () => this.assertAlive(this.fullscreen)
    private assertAlive<T>(value: T): T {
      state.nativeReadCount += 1
      if (this.destroyed) throw new Error('Object has been destroyed')
      return value
    }
    show = vi.fn(() => { state.shownCount += 1 })
    showInactive = vi.fn(() => { state.shownInactiveCount += 1 })
    loadFile = vi.fn(() => Promise.resolve())
  }
  return {
    app: { isPackaged: true, getPath: () => '/tmp/geometry-test' },
    BrowserWindow,
    View,
    WebContentsView,
    screen: createTestScreen({
      getNearestWorkArea: () => state.workArea,
      getMatchingWorkArea: () => state.matchingWorkArea ?? state.workArea,
    }),
    default: {},
  }
})

vi.mock('../../utils/paths.js', () => ({ mainPreloadPath: '/fake/preload.js' }))
vi.mock('../../utils/theme.js', () => ({ themeBg: () => '#000000', syncDocumentTheme: vi.fn() }))
vi.mock('../navigation-hardening.js', () => ({ applyNavigationHardening: vi.fn() }))

async function create(key: string, options: Record<string, unknown> = {}) {
  const { createMainWindow } = await import('./create.js')
  const win = createMainWindow({ indexHtml: '/fake/index.html', geometryKey: key, autoShow: false, ...options }) as unknown as typeof state.windows[number]
  win.emit('ready-to-show')
  return win
}

async function createWithoutGeometryKey(options: Record<string, unknown> = {}) {
  const { createMainWindow } = await import('./create.js')
  return createMainWindow({ indexHtml: '/fake/index.html', ...options }) as unknown as typeof state.windows[number]
}

function close(win: typeof state.windows[number]): void {
  win.emit('close')
  win.emit('closed')
}

describe('main window geometry persistence', () => {
  beforeEach(() => {
    state.files.clear()
    state.windows.length = 0
    state.workArea = { x: 0, y: 0, width: 1440, height: 900 }
    state.failWrite = false
    state.failRename = false
    state.failRead = false
    state.matchingWorkArea = undefined
    state.nativeReadCount = 0
    state.shownCount = 0
    state.shownInactiveCount = 0
  })

  it('restores a project window’s normal outer bounds after it closes and opens again', async () => {
    const first = await create('project:/tmp/geometry-project')
    first.bounds = { x: 120, y: 80, width: 800, height: 600 }
    close(first)

    const second = await create('project:/tmp/geometry-project')

    expect(second.options).toEqual(expect.objectContaining({ x: 120, y: 80, width: 800, height: 600 }))
  })

  it('restores persisted bounds after the window modules are rebuilt', async () => {
    const first = await create('project:/tmp/reload')
    first.bounds = { x: 70, y: 80, width: 800, height: 600 }
    close(first)
    vi.resetModules()

    const second = await create('project:/tmp/reload')

    expect(second.options).toEqual(expect.objectContaining({ x: 70, y: 80, width: 800, height: 600 }))
  })

  it('keeps projects isolated and uses the persisted normal bounds from a maximized window', async () => {
    const first = await create('project:/tmp/a')
    first.normalBounds = { x: 40, y: 60, width: 800, height: 600 }
    first.maximized = true
    close(first)

    const otherProject = await create('project:/tmp/b')
    const reopened = await create('project:/tmp/a')

    expect(otherProject.options).toEqual(expect.objectContaining({ width: 1280, height: 900 }))
    expect(reopened.options).toEqual(expect.objectContaining({ x: 40, y: 60, width: 800, height: 600 }))
  })

  it('uses normal bounds from a fullscreen window', async () => {
    const first = await create('project:/tmp/fullscreen')
    first.normalBounds = { x: 50, y: 70, width: 800, height: 600 }
    first.fullscreen = true
    close(first)

    const reopened = await create('project:/tmp/fullscreen')

    expect(reopened.options).toEqual(expect.objectContaining({ x: 50, y: 70, width: 800, height: 600 }))
  })

  it('keeps restored windows visible and honors explicit minimum bounds after a display shrinks', async () => {
    const first = await create('project:/tmp/shrink')
    first.bounds = { x: 1200, y: 800, width: 1000, height: 800 }
    close(first)
    state.workArea = { x: -1600, y: 40, width: 700, height: 450 }

    const reopened = await create('project:/tmp/shrink', { minWidth: 640, minHeight: 400 })

    expect(reopened.options).toEqual(expect.objectContaining({
      x: -1600,
      y: 40,
      width: 700,
      height: 450,
      minWidth: 640,
      minHeight: 400,
    }))
  })

  it('does not let an older window close overwrite a newer owner’s geometry', async () => {
    const older = await create('project:/tmp/race')
    const newer = await create('project:/tmp/race')
    newer.bounds = { x: 200, y: 100, width: 800, height: 600 }
    close(newer)
    older.bounds = { x: 10, y: 10, width: 700, height: 500 }
    close(older)

    const reopened = await create('project:/tmp/race')

    expect(reopened.options).toEqual(expect.objectContaining({ x: 200, y: 100, width: 800, height: 600 }))
  })

  it('falls back to a centered default when stored geometry is corrupt', async () => {
    state.files.set('/tmp/geometry-test/dimina-window-geometry.json', '{not json')

    const win = await create('project:/tmp/corrupt')

    expect(win.options).toEqual(expect.objectContaining({ x: 80, y: 0, width: 1280, height: 900 }))
  })

  it.each(['write', 'rename'] as const)('keeps the last valid geometry when atomic %s fails', async (operation) => {
    const first = await create('project:/tmp/io-failure')
    first.bounds = { x: 20, y: 30, width: 800, height: 600 }
    close(first)
    const before = new Map(state.files)
    expect(before.size).toBeGreaterThan(0)
    const second = await create('project:/tmp/io-failure')
    second.bounds = { x: 40, y: 50, width: 700, height: 500 }
    if (operation === 'write') state.failWrite = true
    else state.failRename = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => close(second)).not.toThrow()
    expect(state.files).toEqual(before)
    expect([...state.files.keys()].some((file) => file.endsWith('.tmp'))).toBe(false)
    warn.mockRestore()
  })

  it('does not overwrite other projects when reading saved geometry fails', async () => {
    const first = await create('project:/tmp/one')
    first.bounds = { x: 20, y: 30, width: 800, height: 600 }
    close(first)
    const second = await create('project:/tmp/two')
    second.bounds = { x: 40, y: 50, width: 700, height: 500 }
    close(second)
    const before = new Map(state.files)
    expect(before.size).toBeGreaterThan(0)
    const third = await create('project:/tmp/three')
    state.failRead = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => close(third)).not.toThrow()
    expect(state.files).toEqual(before)
    warn.mockRestore()
  })

  it('preserves the same project record when it cannot be read during save', async () => {
    const key = 'project:/tmp/unreadable-owner'
    const first = await create(key)
    first.bounds = { x: 20, y: 30, width: 800, height: 600 }
    close(first)
    const second = await create(key)
    second.bounds = { x: 40, y: 50, width: 700, height: 500 }
    const before = new Map(state.files)
    expect(before.size).toBe(1)
    state.failRead = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => close(second)).not.toThrow()
    expect(state.files).toEqual(before)
    state.failRead = false
    const reopened = await create(key)
    expect(reopened.options).toEqual(expect.objectContaining(first.bounds))
    warn.mockRestore()
  })

  it('uses legacy only while the per-key file is missing, then prefers its own record', async () => {
    const key = 'project:/tmp/legacy'
    const legacy = '/tmp/geometry-test/dimina-window-geometry.json'
    state.files.set(legacy, JSON.stringify({ [key]: { x: 10, y: 20, width: 800, height: 600 } }))
    const { loadWindowGeometry, saveWindowGeometry } = await import('./window-geometry.js')
    expect(loadWindowGeometry(key)).toEqual({ x: 10, y: 20, width: 800, height: 600 })
    saveWindowGeometry(key, { x: 30, y: 40, width: 700, height: 500 })
    expect(loadWindowGeometry(key)).toEqual({ x: 30, y: 40, width: 700, height: 500 })
    expect(state.files.get(legacy)).toBe(JSON.stringify({ [key]: { x: 10, y: 20, width: 800, height: 600 } }))
  })

  it('does not revive legacy bounds when an own record is corrupt, mismatched, or unreadable', async () => {
    const key = 'project:/tmp/own-invalid'
    const { loadWindowGeometry, saveWindowGeometry } = await import('./window-geometry.js')
    saveWindowGeometry(key, { x: 1, y: 2, width: 800, height: 600 })
    const own = [...state.files.keys()].find((file) => file.includes('/window-geometry/'))!
    state.files.set('/tmp/geometry-test/dimina-window-geometry.json', JSON.stringify({ [key]: { x: 9, y: 9, width: 800, height: 600 } }))
    state.files.set(own, '{bad')
    expect(loadWindowGeometry(key)).toBeUndefined()
    state.files.set(own, JSON.stringify({ key: 'project:/tmp/other', bounds: { x: 1, y: 2, width: 800, height: 600 } }))
    expect(loadWindowGeometry(key)).toBeUndefined()
    state.files.set(own, JSON.stringify({ key, bounds: { x: 1, y: 2, width: -1, height: 600 } }))
    expect(loadWindowGeometry(key)).toBeUndefined()
    state.failRead = true
    expect(loadWindowGeometry(key)).toBeUndefined()
  })

  it('uses the display matched from saved bounds instead of the cursor display', async () => {
    const first = await create('project:/tmp/secondary')
    first.bounds = { x: -1500, y: 70, width: 800, height: 600 }
    close(first)
    state.matchingWorkArea = { x: -1600, y: 40, width: 900, height: 700 }

    const reopened = await create('project:/tmp/secondary')

    expect(reopened.options).toEqual(expect.objectContaining({ x: -1500, y: 70, width: 800, height: 600 }))
  })

  it('captures the final normal bounds after a canceled close before the window is destroyed', async () => {
    const first = await create('project:/tmp/cancel')
    first.bounds = { x: 10, y: 20, width: 700, height: 500 }
    first.emit('close')
    first.bounds = { x: 30, y: 40, width: 800, height: 600 }
    close(first)

    const reopened = await create('project:/tmp/cancel')

    expect(reopened.options).toEqual(expect.objectContaining({ x: 30, y: 40, width: 800, height: 600 }))
  })

  it('persists the latest resize snapshot when a window is destroyed without a close event', async () => {
    const first = await create('project:/tmp/destroy')
    first.bounds = { x: 140, y: 90, width: 800, height: 600 }
    first.emit('resize')
    first.emit('closed')

    const reopened = await create('project:/tmp/destroy')

    expect(reopened.options).toEqual(expect.objectContaining({ x: 140, y: 90, width: 800, height: 600 }))
  })

  it('does not persist geometry when destroyed before ready-to-show', async () => {
    const { createMainWindow } = await import('./create.js')
    const win = createMainWindow({ indexHtml: '/fake/index.html', geometryKey: 'project:/tmp/not-ready', autoShow: false }) as unknown as typeof state.windows[number]
    win.bounds = { x: 90, y: 90, width: 800, height: 600 }
    close(win)
    expect(state.files.size).toBe(0)
  })

  it('keeps the autoShow ready-to-show contract', async () => {
    const hidden = await createWithoutGeometryKey({ autoShow: false })
    hidden.emit('ready-to-show')
    const visible = await createWithoutGeometryKey({ autoShow: true })
    visible.emit('ready-to-show')

    expect(state.shownCount).toBe(0)
    expect(state.shownInactiveCount).toBe(1)
  })

  it('does not attach geometry lifecycle reads to callers without a geometry key', async () => {
    const win = await createWithoutGeometryKey()
    close(win)

    expect(state.nativeReadCount).toBe(0)
  })
})
