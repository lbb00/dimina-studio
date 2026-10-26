import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { serializeLayout } from 'electron-deck/layout'
import { buildDockModel, buildDockRegistry, buildPresetDockTree } from '../layout/dock-layout'
import { LayoutVisibilityToggles } from './layout-controls'

function renderControls(onPanelOpened = vi.fn()) {
  const ids = new Set(['simulator', 'editor', 'wxml', 'appdata', 'storage', 'console', 'compile'])
  const model = buildDockModel(serializeLayout(buildPresetDockTree(375, 'left', 'inEditor')), 375, ids)
  return {
    model,
    onPanelOpened,
    ...render(<LayoutVisibilityToggles model={model} registry={buildDockRegistry()} simPanelWidth={375} onPanelOpened={onPanelOpened} />),
  }
}

describe('LayoutVisibilityToggles panel activation', () => {
  it.each(['simulator', 'editor'] as const)('requests the reopened %s and does not request its close', (panelId) => {
    const { getByTestId, onPanelOpened } = renderControls()
    const toggle = getByTestId(`layout-toolbar-toggle-${panelId}`)

    fireEvent.click(toggle)
    expect(onPanelOpened).not.toHaveBeenCalled()
    fireEvent.click(toggle)

    expect(onPanelOpened).toHaveBeenCalledTimes(1)
    expect(onPanelOpened).toHaveBeenLastCalledWith(panelId)
  })

  it('requests the active tab of the debug region only when reopening it', () => {
    const { getByTestId, onPanelOpened } = renderControls()
    const toggle = getByTestId('layout-toolbar-toggle-debug')

    fireEvent.click(toggle)
    expect(onPanelOpened).not.toHaveBeenCalled()
    fireEvent.click(toggle)

    expect(onPanelOpened).toHaveBeenCalledTimes(1)
    expect(onPanelOpened).toHaveBeenLastCalledWith('wxml')
  })
})
