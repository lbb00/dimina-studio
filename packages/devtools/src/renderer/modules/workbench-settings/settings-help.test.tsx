import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const apiMocks = vi.hoisted(() => ({
  getWorkbenchSettings: vi.fn(() => Promise.resolve({
    cdp: { enabled: false, port: 9222 },
    mcp: { enabled: false, port: 7789 },
    compile: { autoBuild: true },
    preview: { autoReload: true },
    theme: 'system',
    lastCreateBaseDir: null,
  })),
  getCdpStatus: vi.fn(() => Promise.resolve(null)),
  getMcpStatus: vi.fn(() => Promise.resolve(null)),
  onWorkbenchSettingsInit: vi.fn(() => () => {}),
  restartWorkbench: vi.fn(),
  saveWorkbenchSettings: vi.fn(() => Promise.resolve()),
  setWorkbenchTheme: vi.fn(),
  emitProjectSettingsChanged: vi.fn(),
  notifyOverlayReady: vi.fn(),
  onSettingsInit: vi.fn(() => () => {}),
  setSettingsVisible: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/shared/api', () => apiMocks)

import WorkbenchSettings from './workbench-settings'
import Settings from '../settings/settings'

describe('WorkbenchSettings: settings help', () => {
  const selectTab = (name: string) => {
    const tab = screen.getByRole('tab', { name })
    fireEvent.pointerDown(tab)
    fireEvent.mouseDown(tab)
    fireEvent.mouseUp(tab)
    fireEvent.click(tab)
  }

  const hover = (element: HTMLElement) => {
    fireEvent.pointerMove(element, { pointerType: 'mouse' })
  }

  it('shows auto-build guidance only after hovering its labelled help button', async () => {
    render(<WorkbenchSettings />)

    const guidance = '开启「自动编译」后，打开项目时会监听源文件改动并自动重新编译。配置在下次打开项目时生效。'
    expect(document.body).not.toHaveTextContent(guidance)
    expect(screen.queryByRole('button', { name: '查看编译与预览说明' })).toBeNull()

    const help = screen.getByRole('button', { name: '查看自动编译说明' })
    expect(help).toHaveAttribute('type', 'button')
    hover(help)

    const tooltip = (await screen.findAllByText(guidance))
      .map((node) => node.closest('[data-side]'))
      .find((node): node is Element => node !== null)
    if (!tooltip) throw new Error('Tooltip content is missing its placement element')
    expect(tooltip).toHaveTextContent(guidance)
    expect(tooltip).toHaveClass('bg-popover', 'text-popover-foreground', 'border', 'border-border', 'shadow-md')
    expect(tooltip).not.toHaveClass('pointer-events-none')
    expect(tooltip).toHaveAttribute('data-side', 'bottom')
  })

  it('shows auto-reload guidance only after focusing its labelled help button', async () => {
    render(<WorkbenchSettings />)

    const guidance = '开启「自动刷新」后，每次编译完成会刷新模拟器（仅改样式时原地热替换，保留当前页面栈与表单状态）；关闭它则任何改动都不刷新，仅手动刷新。配置在下次打开项目时生效。'
    expect(document.body).not.toHaveTextContent(guidance)
    expect(screen.queryByRole('button', { name: '查看编译与预览说明' })).toBeNull()

    const help = screen.getByRole('button', { name: '查看自动刷新说明' })
    expect(help).toHaveAttribute('type', 'button')
    fireEvent.focus(help)

    expect(await screen.findByRole('tooltip')).toHaveTextContent(guidance)
  })

  it('shows DevTools Protocol guidance beside its enable label', async () => {
    render(<WorkbenchSettings />)

    selectTab('调试')
    const guidance = '开启后可通过 DevTools Protocol 连接调试模拟器。配置变更需要重启应用后生效。'
    expect(document.body).not.toHaveTextContent(guidance)
    expect(screen.queryByRole('button', { name: '查看 DevTools Protocol 说明' })).toBeNull()

    const help = screen.getByRole('button', { name: '查看启用 DevTools Protocol 说明' })
    expect(help).toHaveAttribute('type', 'button')
    fireEvent.focus(help)

    expect(await screen.findByRole('tooltip')).toHaveTextContent(guidance)
  })

  it('shows MCP guidance beside its enable label', async () => {
    render(<WorkbenchSettings />)

    selectTab('MCP')
    const guidance = 'AI 助手可以通过 MCP 连接当前开发工具，读取 console、截图、执行 JS、查看 DOM / Storage / 网络请求。启用后开发工具启动时会自动监听 SSE 端点，并自动启用 CDP。'
    expect(document.body).not.toHaveTextContent(guidance)
    expect(screen.queryByRole('button', { name: '查看 MCP 配置说明' })).toBeNull()

    const help = screen.getByRole('button', { name: '查看启用 MCP 服务说明' })
    expect(help).toHaveAttribute('type', 'button')
    fireEvent.focus(help)

    expect(await screen.findByRole('tooltip')).toHaveTextContent(guidance)
  })

  it('keeps port defaults inside labelled help tooltips', async () => {
    render(<WorkbenchSettings />)

    selectTab('调试')
    expect(document.body).not.toHaveTextContent('默认 9222')
    fireEvent.focus(screen.getByRole('button', { name: '查看调试端口默认值说明' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('默认 9222')

    selectTab('MCP')
    expect(document.body).not.toHaveTextContent('默认 7789')
    fireEvent.focus(screen.getByRole('button', { name: '查看 SSE 端口默认值说明' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('默认 7789')
  })

  it('keeps the settings sheet description for assistive technology and shows it on help focus', async () => {
    render(<Settings />)

    const description = screen
      .getAllByText('管理开发工具和当前项目的配置。')
      .find((node) => node.classList.contains('sr-only'))
    expect(description).toBeDefined()
    expect(description).toHaveClass('sr-only')
    fireEvent.focus(screen.getByRole('button', { name: '查看设置说明' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('管理开发工具和当前项目的配置。')
  })
})
