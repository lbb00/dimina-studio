import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CompileStatusDetails } from './compile-status-details'

const { showCompileStatusDetails } = vi.hoisted(() => ({ showCompileStatusDetails: vi.fn() }))
vi.mock('@/shared/api', () => ({ showCompileStatusDetails }))

describe('CompileStatusDetails', () => {
  it('asks main to show the native details panel', () => {
    render(<CompileStatusDetails status="error" message={'first line\nfull detail'} diagnostics={[{ source: '/project/pages/a.ts', line: 3, column: 7, endLine: 3, endColumn: 8, message: 'unexpected token', severity: 'error' }]} previewStale />)
    const trigger = screen.getByRole('button', { name: '查看编译错误' })
    fireEvent.click(trigger)
    expect(showCompileStatusDetails).toHaveBeenCalledOnce()
  })

  it('does not claim an old preview for a ready status', () => {
    render(<CompileStatusDetails status="ready" message="编译完成" previewStale />)
    expect(screen.queryByText('模拟器显示上次成功编译的内容。')).toBeNull()
  })
})
