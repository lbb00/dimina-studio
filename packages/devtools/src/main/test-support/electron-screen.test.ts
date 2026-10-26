import { describe, expect, it } from 'vitest'
import { createTestScreen } from './electron-screen.js'

describe('createTestScreen', () => {
  it('provides the default display for both window placement paths', () => {
    const screen = createTestScreen()
    expect(screen.getCursorScreenPoint()).toEqual({ x: 0, y: 0 })
    expect(screen.getDisplayMatching({}).workArea).toEqual({ x: 0, y: 0, width: 1440, height: 900 })
    expect(screen.getDisplayNearestPoint({}).workArea).toEqual({ x: 0, y: 0, width: 1440, height: 900 })
  })

  it('uses the requested work area without sharing mutable display state', () => {
    const screen = createTestScreen({ workArea: { x: -1200, y: 20, width: 800, height: 600 }, cursorPoint: { x: 5, y: 7 }, matchingWorkArea: { x: 2, y: 3, width: 400, height: 300 } })
    const matching = screen.getDisplayMatching({})
    matching.workArea.width = 1
    expect(screen.getCursorScreenPoint()).toEqual({ x: 5, y: 7 })
    expect(screen.getDisplayMatching({}).workArea).toEqual({ x: 2, y: 3, width: 400, height: 300 })
    expect(screen.getDisplayNearestPoint({}).workArea).toEqual({ x: -1200, y: 20, width: 800, height: 600 })
  })
})
