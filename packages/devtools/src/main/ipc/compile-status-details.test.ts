import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: new EventEmitter() }))
import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { CompileStatusChannel } from '../../shared/ipc-channels-overlays.js'
import { createSessionStatusStore } from '../services/workspace/session-status-store.js'
import { registerCompileStatusDetailsIpc } from './compile-status-details.js'

const bus = ipcMain as unknown as EventEmitter
function sender(id: number) {
  return { id, mainFrame: { processId: 1, routingId: id }, isDestroyed: () => false, getURL: () => 'file:///trusted/index.html' } as unknown as WebContents
}
function context() {
  return { sessionStatus: createSessionStatusStore(), views: {
    showCompileStatusDetails: vi.fn(), hideCompileStatusDetails: vi.fn(),
  } }
}
function emit(channel: string, source: WebContents, senderFrame: unknown = source.mainFrame, payload?: unknown) {
  bus.emit(channel, { sender: source, senderFrame }, payload)
}
afterEach(() => { bus.removeAllListeners(); vi.restoreAllMocks() })

describe('compile details window ownership', () => {
  it('follows the authoritative status until close, hiding on a successful newer generation', () => {
    const source = sender(1), ctx = context()
    ctx.sessionStatus.record({ status: 'error', message: 'first' })
    const registration = registerCompileStatusDetailsIpc({ resolve: wc => wc === source ? ctx : null, list: () => [ctx] })
    emit(CompileStatusChannel.Show, source)
    ctx.sessionStatus.record({ status: 'error', message: 'newer error' })
    expect(ctx.views.showCompileStatusDetails).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'newer error' }))
    ctx.sessionStatus.record({ status: 'ready', message: 'fixed' })
    expect(ctx.views.hideCompileStatusDetails).toHaveBeenCalledOnce()
    ctx.sessionStatus.record({ status: 'error', message: 'must stay closed' })
    expect(ctx.views.showCompileStatusDetails).toHaveBeenCalledTimes(2)
    registration.dispose()
  })
  it('reads current authority per window and ignores client-provided error contents', () => {
    const first = sender(1), second = sender(2)
    const left = context(), right = context()
    left.sessionStatus.record({ status: 'error', message: 'left source error', previewStale: true })
    right.sessionStatus.record({ status: 'error', message: 'right source error' })
    const owners = new Map([[first, left], [second, right]])
    const registration = registerCompileStatusDetailsIpc({ resolve: wc => owners.get(wc) ?? null, list: () => [...owners.values()] })
    emit(CompileStatusChannel.Show, first, first.mainFrame, { message: 'forged message' })
    expect(left.views.showCompileStatusDetails).toHaveBeenCalledExactlyOnceWith(left.sessionStatus.get())
    expect(right.views.showCompileStatusDetails).not.toHaveBeenCalled()
    emit(CompileStatusChannel.Show, second)
    expect(right.views.showCompileStatusDetails).toHaveBeenCalledExactlyOnceWith(right.sessionStatus.get())
    emit(CompileStatusChannel.Hide, first)
    expect(left.views.hideCompileStatusDetails).toHaveBeenCalledTimes(1)
    expect(right.views.hideCompileStatusDetails).not.toHaveBeenCalled()
    left.sessionStatus.record({ status: 'ready', message: 'fixed' })
    emit(CompileStatusChannel.Show, first)
    expect(left.views.showCompileStatusDetails).toHaveBeenCalledTimes(1)
    registration.dispose()
    expect(bus.listenerCount(CompileStatusChannel.Show)).toBe(0)
    expect(bus.listenerCount(CompileStatusChannel.Hide)).toBe(0)
    emit(CompileStatusChannel.Show, second)
    expect(right.views.showCompileStatusDetails).toHaveBeenCalledTimes(1)
  })

  it('rejects unknown senders, subframes, and senders released by their owner', () => {
    const trusted = sender(1), foreign = sender(99)
    const ctx = context()
    ctx.sessionStatus.record({ status: 'error', message: 'original' })
    let alive = true
    const registration = registerCompileStatusDetailsIpc({ resolve: wc => alive && wc === trusted ? ctx : null, list: () => alive ? [ctx] : [] })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    emit(CompileStatusChannel.Show, foreign)
    emit(CompileStatusChannel.Show, trusted, { processId: 1, routingId: 88 })
    emit(CompileStatusChannel.Hide, trusted, null)
    expect(ctx.views.showCompileStatusDetails).not.toHaveBeenCalled()
    expect(ctx.views.hideCompileStatusDetails).not.toHaveBeenCalled()
    emit(CompileStatusChannel.Show, trusted)
    expect(ctx.views.showCompileStatusDetails).toHaveBeenCalledTimes(1)
    alive = false
    emit(CompileStatusChannel.Hide, trusted)
    expect(ctx.views.hideCompileStatusDetails).not.toHaveBeenCalled()
    registration.dispose()
  })
})
