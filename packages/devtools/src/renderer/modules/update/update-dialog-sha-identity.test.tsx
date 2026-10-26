import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeStrictMock, onMock, sendMock, listeners } = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  return {
    invokeStrictMock: vi.fn(),
    onMock: vi.fn((channel: string, callback: (...args: unknown[]) => void) => {
      listeners.set(channel, callback)
      return () => listeners.delete(channel)
    }),
    sendMock: vi.fn(),
    listeners,
  }
})

vi.mock('@/shared/api/ipc-transport', () => ({
  invokeStrict: invokeStrictMock,
  on: onMock,
  send: sendMock,
}))

import { UpdateChannel } from '../../../shared/ipc-channels-overlays.js'
import { UpdateDialog } from './update-dialog'

const first = { version: '2.0.0', downloadUrl: 'Dimina-2.0.0.zip', sha512: 'old-checksum' }
const replacement = { version: '2.0.0', downloadUrl: 'Dimina-2.0.0.zip', sha512: 'new-checksum' }

beforeEach(() => {
  invokeStrictMock.mockReset()
  sendMock.mockReset()
  listeners.clear()
})

describe('UpdateDialog checksum identity', () => {
  it('returns to prompt and ignores the old download completion when only checksum changes', async () => {
    let settleOld!: (result: { success: boolean; error?: string }) => void
    invokeStrictMock.mockImplementationOnce(() => new Promise((resolve) => { settleOld = resolve }))
    render(<UpdateDialog />)

    act(() => { listeners.get(UpdateChannel.Available)!(first) })
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }))
    act(() => {
      listeners.get(UpdateChannel.Available)!({
        ...replacement,
        downloadState: { stage: 'prompt', progress: 0 },
      })
    })
    settleOld({ success: false, error: 'old request failed' })

    expect(await screen.findByText('New version 2.0.0 is available.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument()
    expect(screen.queryByText('Download failed: old request failed')).toBeNull()
  })
})
