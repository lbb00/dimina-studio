import type { Rectangle, Screen } from 'electron'

export interface WindowSizeRequest {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

export interface WorkAreaSize {
  width: number
  height: number
}

export interface WorkArea extends WorkAreaSize {
  x: number
  y: number
}

export interface WindowSizeOptions extends WindowSizeRequest {
  x: number
  y: number
}

function clamp(value: number, maximum: number): number {
  return Math.min(Math.max(1, value), Math.max(1, maximum))
}

/** Keep the initial outer size and Electron minimum inside the selected display. */
export function resolveWindowSize(
  requested: WindowSizeRequest,
  workArea: WorkAreaSize,
): WindowSizeRequest {
  const minWidth = clamp(requested.minWidth, workArea.width)
  const minHeight = clamp(requested.minHeight, workArea.height)
  const width = clamp(Math.max(requested.width, minWidth), workArea.width)
  const height = clamp(Math.max(requested.height, minHeight), workArea.height)
  return {
    width,
    height,
    minWidth,
    minHeight,
  }
}

/** Use the related window's display, or the display under the pointer for a root window. */
export function getWindowSizeOptions(
  requested: WindowSizeRequest,
  displayScreen: Screen,
  referenceBounds?: Rectangle,
  restoredBounds?: Rectangle,
): WindowSizeOptions {
  const display = referenceBounds
    ? displayScreen.getDisplayMatching(referenceBounds)
    : displayScreen.getDisplayNearestPoint(displayScreen.getCursorScreenPoint())
  const workArea: WorkArea = display.workArea
  const size = resolveWindowSize({
    ...requested,
    width: restoredBounds?.width ?? requested.width,
    height: restoredBounds?.height ?? requested.height,
  }, workArea)
  const x = restoredBounds
    ? Math.max(workArea.x, Math.min(restoredBounds.x, workArea.x + workArea.width - size.width))
    : workArea.x + Math.floor((workArea.width - size.width) / 2)
  const y = restoredBounds
    ? Math.max(workArea.y, Math.min(restoredBounds.y, workArea.y + workArea.height - size.height))
    : workArea.y + Math.floor((workArea.height - size.height) / 2)
  return {
    ...size,
    x,
    y,
  }
}
