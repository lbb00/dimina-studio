import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Project } from '@/shared/types'

const imported: Project = { name: '中文 项目', path: '/目录/带 空格/小程序', lastOpened: null }

const api = vi.hoisted(() => ({
  listProjects: vi.fn(), getThumbnail: vi.fn(async () => null), getBranding: vi.fn(async () => undefined),
  chooseProjectDirectory: vi.fn(), addProject: vi.fn(), importProject: vi.fn(), openProjectWindow: vi.fn(),
  onProjectsChanged: vi.fn(() => () => {}), onWindowNavigateBack: vi.fn(() => () => {}),
  onWindowOpenProject: vi.fn(() => () => {}), onProjectCreateSubmitted: vi.fn(() => () => {}),
  getHostSidebarWidth: vi.fn(async () => 0), onHostSidebarWidthChanged: vi.fn(() => () => {}),
  onHostSidebarCategorySelected: vi.fn(() => () => {}), publishPlacementSnapshot: vi.fn(async () => {}),
}))
vi.mock('@/shared/api', () => api)
vi.mock('view-anchor/react', () => ({ useViewAnchor: () => () => {} }))
import Main from './main'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

async function openImport() {
  fireEvent.click(await screen.findByText('导入'))
  return screen.findByLabelText('项目目录') as Promise<HTMLInputElement>
}

beforeEach(() => {
  vi.clearAllMocks()
  api.listProjects.mockResolvedValue([])
  api.importProject.mockResolvedValue(imported)
  api.chooseProjectDirectory.mockResolvedValue(null)
})

afterEach(() => { vi.restoreAllMocks() })

describe('Main import dialog', () => {
  it('opens a path form instead of immediately opening the native picker', async () => {
    render(<Main />)
    expect(await openImport()).toBeInTheDocument()
    expect(api.chooseProjectDirectory).not.toHaveBeenCalled()
  })

  it('imports a Chinese path with spaces once on Enter, then refreshes and opens the returned project', async () => {
    render(<Main />)
    const input = await openImport()
    fireEvent.change(input, { target: { value: ` ${imported.path} ` } })
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))

    await waitFor(() => expect(api.importProject).toHaveBeenCalledWith(imported.path))
    expect(api.importProject).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(api.openProjectWindow).toHaveBeenCalledWith(imported))
  })

  it('keeps the typed path when the native directory dialog is cancelled', async () => {
    render(<Main />)
    const input = await openImport()
    fireEvent.change(input, { target: { value: '/already/typed' } })
    fireEvent.click(screen.getByRole('button', { name: '选择目录' }))

    await waitFor(() => expect(api.chooseProjectDirectory).toHaveBeenCalledOnce())
    expect(input).toHaveValue('/already/typed')
    expect(screen.getByLabelText('项目目录')).toBeInTheDocument()
  })

  it('only writes a successfully selected directory into the form until the user submits it', async () => {
    api.chooseProjectDirectory.mockResolvedValueOnce(imported.path)
    render(<Main />)
    const input = await openImport()
    fireEvent.click(screen.getByRole('button', { name: '选择目录' }))

    await waitFor(() => expect(input).toHaveValue(imported.path))
    expect(api.importProject).not.toHaveBeenCalled()
  })

  it('shows a picker rejection and allows another directory selection', async () => {
    api.chooseProjectDirectory
      .mockRejectedValueOnce(new Error('native picker unavailable'))
      .mockResolvedValueOnce(imported.path)
    render(<Main />)
    const input = await openImport()
    fireEvent.change(input, { target: { value: '/already/typed' } })
    fireEvent.click(screen.getByRole('button', { name: '选择目录' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('native picker unavailable')
    expect(input).toHaveValue('/already/typed')
    fireEvent.click(screen.getByRole('button', { name: '选择目录' }))
    await waitFor(() => expect(input).toHaveValue(imported.path))
  })

  it('submits a picker-selected path exactly as returned', async () => {
    const selectedPath = '/目录/末尾空格 '
    api.chooseProjectDirectory.mockResolvedValueOnce(selectedPath)
    render(<Main />)
    const input = await openImport()
    fireEvent.click(screen.getByRole('button', { name: '选择目录' }))
    await waitFor(() => expect(input).toHaveValue(selectedPath))
    fireEvent.click(screen.getByRole('button', { name: '导入' }))

    await waitFor(() => expect(api.importProject).toHaveBeenCalledWith(selectedPath))
  })

  it('shows an import failure, retains the path, and permits a retry', async () => {
    api.importProject.mockRejectedValueOnce(new Error('目录不是有效的小程序项目')).mockResolvedValueOnce(imported)
    render(<Main />)
    const input = await openImport()
    fireEvent.change(input, { target: { value: imported.path } })
    fireEvent.click(screen.getByRole('button', { name: '导入' }))

    expect(await screen.findByText('目录不是有效的小程序项目')).toBeInTheDocument()
    expect(input).toHaveValue(imported.path)
    fireEvent.click(screen.getByRole('button', { name: '导入' }))
    await waitFor(() => expect(api.importProject).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(api.openProjectWindow).toHaveBeenCalledWith(imported))
  })

  it('does not let a late picker result alter a reopened form and ignores a late rejection after unmount', async () => {
    const first = deferred<string | null>()
    const second = deferred<string | null>()
    api.chooseProjectDirectory.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rendered = render(<Main />)
    await openImport()
    fireEvent.click(screen.getByRole('button', { name: '选择目录' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByLabelText('项目目录')).not.toBeInTheDocument())
    const reopened = await openImport()
    await act(async () => { first.resolve('/late/old'); await first.promise })
    expect(reopened).toHaveValue('')

    fireEvent.click(screen.getByRole('button', { name: '选择目录' }))
    rendered.unmount()
    await act(async () => {
      second.reject(new Error('picker closed after owner disposal'))
      await second.promise.catch(() => {})
    })
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('does not refresh or open when a late import resolves after Main unmounts', async () => {
    const adding = deferred<Project>()
    api.importProject.mockReturnValueOnce(adding.promise)
    const rendered = render(<Main />)
    const input = await openImport()
    fireEvent.change(input, { target: { value: imported.path } })
    fireEvent.click(screen.getByRole('button', { name: '导入' }))
    await waitFor(() => expect(api.importProject).toHaveBeenCalledOnce())
    const listsBeforeUnmount = api.listProjects.mock.calls.length

    rendered.unmount()
    await act(async () => { adding.resolve(imported); await adding.promise })

    expect(api.listProjects).toHaveBeenCalledTimes(listsBeforeUnmount)
    expect(api.openProjectWindow).not.toHaveBeenCalled()
  })

  it('discards an import refresh that rejects after Main unmounts', async () => {
    const reload = deferred<Project[]>()
    api.listProjects.mockResolvedValueOnce([]).mockReturnValueOnce(reload.promise)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rendered = render(<Main />)
    const input = await openImport()
    fireEvent.change(input, { target: { value: imported.path } })
    fireEvent.click(screen.getByRole('button', { name: '导入' }))
    await waitFor(() => expect(api.listProjects).toHaveBeenCalledTimes(2))

    rendered.unmount()
    await act(async () => {
      reload.reject(new Error('provider closed after owner disposal'))
      await reload.promise.catch(() => {})
    })

    expect(api.openProjectWindow).not.toHaveBeenCalled()
    expect(warning).not.toHaveBeenCalled()
  })

  it('blocks IME Enter and locks repeated submit, close, and browse while importing', async () => {
    const adding = deferred<Project>()
    api.importProject.mockReturnValueOnce(adding.promise)
    render(<Main />)
    const input = await openImport()
    fireEvent.change(input, { target: { value: imported.path } })
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))
    expect(api.importProject).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '导入' }))
      fireEvent.click(screen.getByRole('button', { name: '导入' }))
    })
    expect(api.importProject).toHaveBeenCalledTimes(1)
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '选择目录' })).toBeDisabled()
    adding.resolve(imported)
    await waitFor(() => expect(api.openProjectWindow).toHaveBeenCalledWith(imported))
  })
})
