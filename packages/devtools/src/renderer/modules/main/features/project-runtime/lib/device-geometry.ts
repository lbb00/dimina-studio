import { SIM_PANEL_PADDING, MIN_PANEL_WIDTH_PX } from '@/shared/constants'

/**
 * Calculate the floor for the simulator column from its framed device width.
 *
 * The frame scales with a fixed numeric zoom, while the desk padding belongs
 * to the surrounding panel and remains in CSS pixels.
 */
export function computeSimPanelWidth(frameWidth: number, zoom = 100): number {
  // The width crosses simulator:attach-native, whose IPC contract is an
  // integer. Rounding up keeps the complete scaled frame and its CSS-pixel
  // desk padding visible instead of clipping a fractional trailing edge.
  return Math.ceil(frameWidth * zoom / 100 + SIM_PANEL_PADDING * 2)
}

/** Clamp a panel width to valid bounds. */
export function clampPanelWidth(width: number, windowWidth: number): number {
  return Math.max(MIN_PANEL_WIDTH_PX, Math.min(windowWidth - MIN_PANEL_WIDTH_PX, width))
}
