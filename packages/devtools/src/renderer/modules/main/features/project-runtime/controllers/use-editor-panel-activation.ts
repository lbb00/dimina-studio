import { useCallback, useEffect, useRef, useState } from 'react'
import { onEditorOpenFile } from '@/shared/api'
import type { LayoutModel } from 'electron-deck/layout'
import { reopenPanel } from '../layout/dock-layout'

export interface PanelActivation {
  panelId: string
  epoch: number
}

/** Keeps source-open and toolbar activation requests in one increasing sequence. */
export function useEditorPanelActivation(dockModel: LayoutModel, simPanelWidth: number): {
  panelActivation: PanelActivation | undefined
  requestPanelActivation: (panelId: string) => void
} {
	const nextEpoch = useRef(0)
	const [activation, setActivation] = useState<PanelActivation>()
	const requestPanelActivation = useCallback((panelId: string) => {
		setActivation({ panelId, epoch: ++nextEpoch.current })
	}, [])

	useEffect(() => {
		let alive = true
		const unsubscribe = onEditorOpenFile(() => {
			if (!alive) return
			dockModel.apply((tree) => reopenPanel(tree, 'editor', simPanelWidth))
			requestPanelActivation('editor')
		})
		return () => {
			alive = false
			unsubscribe()
		}
	}, [dockModel, requestPanelActivation, simPanelWidth])

	return { panelActivation: activation, requestPanelActivation }
}
