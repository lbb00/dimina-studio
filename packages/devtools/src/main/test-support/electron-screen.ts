export interface TestScreenWorkArea {
  x: number
  y: number
  width: number
  height: number
}

export interface TestScreenOptions {
  workArea?: TestScreenWorkArea
  cursorPoint?: { x: number; y: number }
  matchingWorkArea?: TestScreenWorkArea
  nearestWorkArea?: TestScreenWorkArea
  getMatchingWorkArea?: () => TestScreenWorkArea
  getNearestWorkArea?: () => TestScreenWorkArea
}

const defaultWorkArea: TestScreenWorkArea = { x: 0, y: 0, width: 1440, height: 900 }

/** Supplies the screen methods used when a window mock creates its initial bounds. */
export function createTestScreen(options: TestScreenOptions = {}) {
  const workArea = { ...defaultWorkArea, ...options.workArea }
  const cursorPoint = { x: 0, y: 0, ...options.cursorPoint }
  const matchingWorkArea = { ...workArea, ...options.matchingWorkArea }
  const nearestWorkArea = { ...workArea, ...options.nearestWorkArea }
  const createDisplay = (selectedWorkArea: TestScreenWorkArea) => ({ workArea: { ...selectedWorkArea } })
  return {
    getCursorScreenPoint: () => ({ ...cursorPoint }),
    getDisplayMatching: (_bounds: unknown) => createDisplay(options.getMatchingWorkArea?.() ?? matchingWorkArea),
    getDisplayNearestPoint: (_point: unknown) => createDisplay(options.getNearestWorkArea?.() ?? nearestWorkArea),
  }
}
