/**
 * Guards that useDevice's zoom state accepts the 'auto' sentinel alongside the
 * fixed ZOOM_OPTIONS percentages, and that handleZoomChange routes a select's
 * string value to the right branch (AUTO_ZOOM stays the sentinel, everything
 * else becomes a number).
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type React from 'react'
import { AUTO_ZOOM, MIN_PANEL_WIDTH_PX, SIM_PANEL_PADDING } from '@/shared/constants'
import { DEFAULT_DEVICE, DEVICE_NAMES, findDevice } from '@devicekit/devices'
import { frameOuterSize } from '@devicekit/frame'
// useDevice subscribes to the device-picker overlay's result on mount, so the
// hook needs the renderer IPC facade even in a zoom-only suite.
vi.mock('@/shared/api', () => ({
  setNativeDeviceInfo: vi.fn(),
  showDevicePicker: vi.fn(),
  onDevicePickerSelected: vi.fn(() => () => {}),
}))

import { useDevice } from './use-device'

function changeEvent(value: string): React.ChangeEvent<HTMLSelectElement> {
  return { target: { value } } as React.ChangeEvent<HTMLSelectElement>
}

describe('useDevice: zoom accepts the auto-fit sentinel', () => {
  it('defaults to a fixed numeric zoom', () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEFAULT_DEVICE }))
    expect(result.current.zoom).toBe(85)
  })

  it('switches zoom to AUTO_ZOOM when the select value is "auto"', () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEFAULT_DEVICE }))

    act(() => {
      result.current.handleZoomChange(changeEvent(AUTO_ZOOM))
    })

    expect(result.current.zoom).toBe(AUTO_ZOOM)
  })

  it('switches zoom back to a number when a fixed percent is selected afterwards', () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEFAULT_DEVICE }))

    act(() => {
      result.current.handleZoomChange(changeEvent(AUTO_ZOOM))
    })
    act(() => {
      result.current.handleZoomChange(changeEvent('50'))
    })

    expect(result.current.zoom).toBe(50)
  })

  it('releases the numeric frame floor while auto zoom is active', () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEFAULT_DEVICE }))
    act(() => result.current.handleZoomChange(changeEvent(AUTO_ZOOM)))
    expect(result.current.simPanelWidth).toBe(MIN_PANEL_WIDTH_PX)
  })

  it('keeps the dock minimum through a wider device, then restores its exact numeric width', () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEFAULT_DEVICE }))
    const pixel8 = findDevice(DEVICE_NAMES.Pixel_8)!
    act(() => result.current.handleZoomChange(changeEvent(AUTO_ZOOM)))
    act(() => result.current.handleDeviceChange(DEVICE_NAMES.Pixel_8))
    expect(result.current.device.name).toBe(DEVICE_NAMES.Pixel_8)
    expect(result.current.simPanelWidth).toBe(MIN_PANEL_WIDTH_PX)
    act(() => result.current.handleZoomChange(changeEvent('50')))
    expect(result.current.simPanelWidth).toBe(Math.ceil(frameOuterSize(pixel8, 'portrait').width * 0.5 + SIM_PANEL_PADDING * 2))
    act(() => result.current.handleZoomChange(changeEvent(AUTO_ZOOM)))
    expect(result.current.simPanelWidth).toBe(MIN_PANEL_WIDTH_PX)
  })

  it('uses current refs when device and AUTO/numeric changes are batched', () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEFAULT_DEVICE }))
    const pixel8 = findDevice(DEVICE_NAMES.Pixel_8)!
    act(() => {
      result.current.handleZoomChange(changeEvent(AUTO_ZOOM))
      result.current.handleDeviceChange(DEVICE_NAMES.Pixel_8)
      result.current.handleZoomChange(changeEvent('50'))
    })
    expect(result.current.device.name).toBe(DEVICE_NAMES.Pixel_8)
    expect(result.current.simPanelWidth).toBe(Math.ceil(frameOuterSize(pixel8, 'portrait').width * 0.5 + SIM_PANEL_PADDING * 2))
    act(() => {
      result.current.handleZoomChange(changeEvent('50'))
      result.current.handleDeviceChange(DEVICE_NAMES.Pixel_8)
      result.current.handleZoomChange(changeEvent(AUTO_ZOOM))
    })
    expect(result.current.simPanelWidth).toBe(MIN_PANEL_WIDTH_PX)
  })
})
