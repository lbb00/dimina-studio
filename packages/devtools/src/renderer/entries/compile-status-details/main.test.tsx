import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

const api = vi.hoisted(() => ({
  hideCompileStatusDetails: vi.fn(),
  notifyOverlayReady: vi.fn(),
  onCompileStatusDetailsInit: vi.fn(),
}))
vi.mock('@/shared/api', () => api)
import { CompileStatusDetailsPanel } from '@/modules/compile-status-details/compile-status-details-panel'

describe('CompileStatusDetailsPanel', () => {
  let receive: ((payload: { message: string; diagnostics: Array<{ source: string; line: number; column: number; message: string }>; previewStale?: boolean }) => void) | undefined
  beforeEach(() => {
    vi.clearAllMocks()
    api.onCompileStatusDetailsInit.mockImplementation((listener) => { receive = listener; return vi.fn() })
  })

  it('renders the main-provided message, location and stale preview, then closes through main', () => {
    render(<CompileStatusDetailsPanel />)
    act(() => receive!({ message: 'full compiler message', diagnostics: [{ source: 'pages/a.ts', line: 3, column: 7, message: 'unexpected token' }], previewStale: true }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('pages/a.ts:3:7')).toBeTruthy()
    expect(screen.getByText('模拟器显示上次成功编译的内容。')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(api.hideCompileStatusDetails).toHaveBeenCalledTimes(2)
  })

  it('subscribes before declaring the overlay ready, so the initial main push is received', () => {
    api.onCompileStatusDetailsInit.mockImplementation((listener) => {
      receive = listener
      expect(api.notifyOverlayReady).not.toHaveBeenCalled()
      return vi.fn()
    })
    render(<CompileStatusDetailsPanel />)
    expect(api.notifyOverlayReady).toHaveBeenCalledOnce()
    act(() => receive!({ message: 'initial', diagnostics: [{ source: 'first.ts', line: 1, column: 1, message: 'first' }] }))
    expect(screen.getByText('first.ts:1:1')).toBeTruthy()
  })

  it('reopens with the replacement snapshot instead of retaining the prior error', () => {
    render(<CompileStatusDetailsPanel />)
    act(() => receive!({ message: 'first', diagnostics: [{ source: 'a.ts', line: 1, column: 1, message: 'a' }] }))
    act(() => receive!({ message: 'second', diagnostics: [{ source: 'b.ts', line: 2, column: 3, message: 'b' }] }))
    expect(screen.queryByText('a.ts:1:1')).toBeNull()
    expect(screen.getByText('b.ts:2:3')).toBeTruthy()
  })
})
