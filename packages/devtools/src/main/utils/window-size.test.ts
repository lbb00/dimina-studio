import { describe, expect, it, vi } from 'vitest'
import { getWindowSizeOptions, resolveWindowSize } from './window-size.js'

describe('resolveWindowSize', () => {
  it('keeps a new window and its minimum size inside a small work area', () => {
    expect(resolveWindowSize({ width: 1280, height: 980, minWidth: 1000, minHeight: 600 }, {
      width: 800,
      height: 500,
    })).toEqual({ width: 800, height: 500, minWidth: 800, minHeight: 500 })
  })

  it('expands the initial size to an explicit minimum that fits the work area', () => {
    expect(resolveWindowSize({ width: 800, height: 600, minWidth: 1000, minHeight: 700 }, {
      width: 1440,
      height: 900,
    })).toEqual({ width: 1000, height: 700, minWidth: 1000, minHeight: 700 })
  })

  it('uses the related window display instead of the cursor display', () => {
    const matching = vi.fn(() => ({ workArea: { x: -1600, y: 40, width: 800, height: 500 } }))
    const nearest = vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }))
    const point = { x: 20, y: 30 }
    const displayScreen = {
      getCursorScreenPoint: vi.fn(() => point),
      getDisplayMatching: matching,
      getDisplayNearestPoint: nearest,
    }

    expect(getWindowSizeOptions(
      { width: 1280, height: 980, minWidth: 640, minHeight: 480 },
      displayScreen as never,
      { x: 100, y: 100, width: 400, height: 300 },
    )).toEqual({ x: -1600, y: 40, width: 800, height: 500, minWidth: 640, minHeight: 480 })
    expect(matching).toHaveBeenCalledWith({ x: 100, y: 100, width: 400, height: 300 })
    expect(nearest).not.toHaveBeenCalled()
  })

  it('uses the cursor display without a related window', () => {
    const point = { x: 20, y: 30 }
    const nearest = vi.fn(() => ({ workArea: { x: -1600, y: 40, width: 800, height: 500 } }))
    const displayScreen = {
      getCursorScreenPoint: vi.fn(() => point),
      getDisplayMatching: vi.fn(),
      getDisplayNearestPoint: nearest,
    }

    getWindowSizeOptions(
      { width: 1280, height: 980, minWidth: 640, minHeight: 480 },
      displayScreen as never,
    )
    expect(nearest).toHaveBeenCalledWith(point)
  })

  it('clamps restored bounds into their matched display work area', () => {
    const displayScreen = {
      getCursorScreenPoint: vi.fn(),
      getDisplayMatching: vi.fn(() => ({ workArea: { x: -1600, y: 40, width: 800, height: 500 } })),
      getDisplayNearestPoint: vi.fn(),
    }

    expect(getWindowSizeOptions(
      { width: 1280, height: 980, minWidth: 640, minHeight: 480 },
      displayScreen as never,
      { x: 100, y: 100, width: 400, height: 300 },
      { x: 1200, y: 800, width: 1000, height: 800 },
    )).toEqual({ x: -1600, y: 40, width: 800, height: 500, minWidth: 640, minHeight: 480 })
  })
})
