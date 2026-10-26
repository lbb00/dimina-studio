/**
 * `reconcileNow()`'s create/update/destroy classification and the applied
 * bounds/visibility it hands to native effects must not change when its
 * internal `appliedActual` snapshot strategy changes (reference pass-through
 * before `reconcile()`, shallow `Map` copy after `applyViewOps` — see
 * `reconcileNow` in placement-reconciler.ts). A steady-state re-run (nothing
 * changed) must apply zero redundant native ops, and a genuine bounds change
 * must still classify as an update with the new values, not get lost or
 * duplicated by whichever snapshot representation is in play.
 *
 * Drives `createPlacementReconciler` directly (no ViewManager/Electron
 * needed — its own runtime imports never touch `electron`).
 */
import { describe, it, expect, vi } from 'vitest'
import { createPlacementReconciler } from './placement-reconciler.js'
import type { ViewManagerContext } from './view-manager.js'
import { VIEW_ID, VIEW_LAYER } from '../../../shared/view-ids.js'

function makeCtx() {
  const addChildView = vi.fn()
  const removeChildView = vi.fn()
  const mainWindow = {
    destroyed: false,
    isDestroyed(this: { destroyed: boolean }) { return this.destroyed },
    contentView: { addChildView, removeChildView, children: [] as unknown[] },
  }
  return {
    addChildView,
    removeChildView,
    ctx: {
      windows: { mainWindow } as unknown as ViewManagerContext['windows'],
    } as unknown as ViewManagerContext,
  }
}

function makeView() {
  return {
    webContents: { isDestroyed: () => false },
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    setBackgroundColor: vi.fn(),
  }
}

const BOUNDS_A = { x: 0, y: 0, width: 320, height: 800 }
const BOUNDS_B = { x: 10, y: 0, width: 320, height: 800 }

describe('placement-reconciler: reconcileNow steady-state and update classification', () => {
  it('a no-op reconcileNow (nothing changed) applies zero extra native ops', () => {
    const { ctx } = makeCtx()
    const reconciler = createPlacementReconciler(ctx)
    const view = makeView()
    reconciler.registerView(VIEW_ID.hostSidebar, { getView: () => view as never })

    reconciler.setPlacementSnapshot({
      generation: 0,
      epoch: 1,
      views: [{
        viewId: VIEW_ID.hostSidebar,
        placement: { visible: true, bounds: BOUNDS_A },
        layer: VIEW_LAYER.hostSidebar,
      }],
    })
    expect(view.setBounds).toHaveBeenCalledTimes(1)
    expect(view.setBounds).toHaveBeenLastCalledWith(BOUNDS_A)

    // Same desired state, nothing changed: re-running reconcileNow directly
    // (the resize/ResizeObserver hot path re-enters here with no new
    // snapshot) must not re-apply bounds or re-attach.
    reconciler.reconcileNow()
    reconciler.reconcileNow()

    expect(view.setBounds).toHaveBeenCalledTimes(1)
    expect(view.setVisible).not.toHaveBeenCalled()
  })

  it('a real bounds change after a steady period still classifies as an update with the new value', () => {
    const { ctx } = makeCtx()
    const reconciler = createPlacementReconciler(ctx)
    const view = makeView()
    reconciler.registerView(VIEW_ID.hostSidebar, { getView: () => view as never })

    reconciler.setPlacementSnapshot({
      generation: 0,
      epoch: 1,
      views: [{
        viewId: VIEW_ID.hostSidebar,
        placement: { visible: true, bounds: BOUNDS_A },
        layer: VIEW_LAYER.hostSidebar,
      }],
    })
    // Steady re-runs in between, as the resize hot path does.
    reconciler.reconcileNow()

    reconciler.setPlacementSnapshot({
      generation: 0,
      epoch: 2,
      views: [{
        viewId: VIEW_ID.hostSidebar,
        placement: { visible: true, bounds: BOUNDS_B },
        layer: VIEW_LAYER.hostSidebar,
      }],
    })

    expect(view.setBounds).toHaveBeenCalledTimes(2)
    expect(view.setBounds).toHaveBeenLastCalledWith(BOUNDS_B)
  })
})
