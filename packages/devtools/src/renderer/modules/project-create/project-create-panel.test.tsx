/** 取消或创建成功后卸载表单，下一次打开不保留上一项目的输入。 */
import { render, screen, fireEvent, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { onProjectCreateInitMock, notifyOverlayReadyMock, submitProjectCreateMock, createProjectMock, cancelProjectCreateMock, initHandlers } = vi.hoisted(() => {
  const initHandlers: Array<(payload: unknown) => void> = []
  return {
    onProjectCreateInitMock: vi.fn((handler: (payload: unknown) => void) => {
      initHandlers.push(handler)
      return () => {
        const idx = initHandlers.indexOf(handler)
        if (idx >= 0) initHandlers.splice(idx, 1)
      }
    }),
    notifyOverlayReadyMock: vi.fn(),
    submitProjectCreateMock: vi.fn(),
    createProjectMock: vi.fn(),
    cancelProjectCreateMock: vi.fn(),
    initHandlers,
  }
})

vi.mock('@/shared/api', () => ({
  notifyOverlayReady: notifyOverlayReadyMock,
  onProjectCreateInit: onProjectCreateInitMock,
  submitProjectCreate: submitProjectCreateMock,
  createProject: createProjectMock,
  cancelProjectCreate: cancelProjectCreateMock,
  chooseProjectDirectory: vi.fn(async () => null),
}))

import ProjectCreatePanel from './project-create-panel'

const PAYLOAD_A = { templates: [{ id: 'blank', name: 'Blank' }], defaultBaseDir: '/projects' }
const PAYLOAD_B = { templates: [{ id: 'blank', name: 'Blank' }], defaultBaseDir: '/other' }

beforeEach(() => {
  initHandlers.length = 0
  notifyOverlayReadyMock.mockClear()
  submitProjectCreateMock.mockClear()
  createProjectMock.mockReset()
  createProjectMock.mockResolvedValue({ name: 'ProjectA', path: '/projects/ProjectA' })
  cancelProjectCreateMock.mockClear()
})

function fireInit(payload: unknown) {
  act(() => { for (const h of [...initHandlers]) h(payload) })
}

describe('ProjectCreatePanel: cancel/reopen does not leak the previous session\'s typed input', () => {
  it('cancelling clears the typed 项目名 before the next show renders', async () => {
    render(<ProjectCreatePanel />)
    fireInit(PAYLOAD_A)

    fireEvent.change(await screen.findByLabelText('项目名'), { target: { value: 'ProjectA' } })
    expect(screen.getByLabelText('项目名')).toHaveValue('ProjectA')

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(cancelProjectCreateMock).toHaveBeenCalledTimes(1)

    fireInit(PAYLOAD_B)

    expect(await screen.findByLabelText('项目名')).toHaveValue('')
  })

  it('submitting also clears the typed 项目名 before the next show renders', async () => {
    render(<ProjectCreatePanel />)
    fireInit(PAYLOAD_A)

    fireEvent.change(await screen.findByLabelText('项目名'), { target: { value: 'ProjectA' } })
    fireEvent.click(screen.getByRole('button', { name: '创建并打开' }))
    await vi.waitFor(() => expect(submitProjectCreateMock).toHaveBeenCalledTimes(1))

    fireInit(PAYLOAD_B)

    expect(await screen.findByLabelText('项目名')).toHaveValue('')
  })
})


describe('ProjectCreatePanel creation outcomes', () => {
  it('keeps the visible form and inputs after creation rejects and allows a retry', async () => {
    createProjectMock.mockRejectedValueOnce(new Error('directory occupied'))
    render(<ProjectCreatePanel />)
    fireInit(PAYLOAD_A)
    fireEvent.change(await screen.findByLabelText('项目名'), { target: { value: 'ProjectA' } })
    fireEvent.change(screen.getByLabelText('目录'), { target: { value: '/projects/manual' } })
    fireEvent.click(screen.getByRole('button', { name: '创建并打开' }))
    await vi.waitFor(() => expect(createProjectMock).toHaveBeenCalledTimes(1))
    expect(await screen.findByLabelText('项目名')).toHaveValue('ProjectA')
    expect(screen.getByLabelText('目录')).toHaveValue('/projects/manual')
    expect(submitProjectCreateMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '创建并打开' }))
    await vi.waitFor(() => expect(submitProjectCreateMock).toHaveBeenCalledTimes(1))
    expect(createProjectMock).toHaveBeenCalledTimes(2)
  })

  it('does not submit twice while creation is pending or relay a cancelled result into a new form', async () => {
    let resolve!: (value: unknown) => void
    createProjectMock.mockReturnValueOnce(new Promise(r => { resolve = r }))
    render(<ProjectCreatePanel />)
    fireInit(PAYLOAD_A)
    fireEvent.change(await screen.findByLabelText('项目名'), { target: { value: 'ProjectA' } })
    fireEvent.click(screen.getByRole('button', { name: '创建并打开' }))
    fireEvent.click(screen.getByRole('button', { name: '创建并打开' }))
    expect(createProjectMock).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('项目名')).toBeDisabled()
    expect(screen.getByLabelText('目录')).toBeDisabled()
    expect(screen.getByRole('button', { name: '浏览' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '创建并打开' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '取消' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireInit(PAYLOAD_B)
    await act(async () => { resolve({ name: 'ProjectA', path: '/projects/ProjectA' }) })
    expect(submitProjectCreateMock).not.toHaveBeenCalled()
    expect(screen.getByLabelText('项目名')).toHaveValue('')
  })
})
