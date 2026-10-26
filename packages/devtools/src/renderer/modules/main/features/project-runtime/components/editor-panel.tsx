import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { createViewAnchor, type Placement, type ViewAnchorHandle } from 'view-anchor'
import { usePlacementPublisher } from '@/shared/placement-publisher-context'
import { VIEW_ID, VIEW_LAYER } from '../../../../../../shared/view-ids'
import { useDockLayoutEpoch } from 'electron-deck/dock-react'

// The editor is the embedded VS Code workbench: a main-process
// WebContentsView painted directly over this DOM dock body. This renderer panel
// draws NO chrome — the body is a single full-size anchor div over which the
// workbench WCV is overlaid (the workbench renders its own toolbar/tabs inside
// its WebContents, whose DOM lives in a separate process and never appears in
// the main window).
//
// This component is the SOLE workbench-WCV anchor owner. It binds an imperative
// `createViewAnchor` to the body div and maps its placement to
// `publishWorkbenchBounds` → main's `setWorkbenchBounds`. The first non-zero
// bounds lazily attaches the workbench WCV (the lazy-load contract), so the
// anchor must publish a live rect as soon as the editor body is on screen.
//
// Under DOM-panel keepalive the body is NOT unmounted when its dock tab
// deactivates — its slot merely goes `display:none`. To collapse the WCV on
// deactivation it opts into view-anchor's `treatZeroAreaAsHidden`: an
// IntersectionObserver re-fires on a `display:none` transition (invisible to
// ResizeObserver) and the resulting zero-area measure becomes a
// `{ visible:false }` publish, which `publish` maps to COLLAPSED 0×0 bounds
// (detach-but-keep-alive). 祖先滚动时跟随几何变化；dock 布局提交后
// 通过 update() 立即重测位置，覆盖尺寸不变的移动。
export function EditorPanel() {
  const anchorHandleRef = useRef<ViewAnchorHandle | null>(null)

  const publisher = usePlacementPublisher()
  const publish = useCallback((p: Placement) => {
    publisher?.set({ viewId: VIEW_ID.workbench, placement: p, layer: VIEW_LAYER.base })
  }, [publisher])

  // Ref-callback binding the placement anchor to the editor body div. Mirrors
  // the dock native-slot lifecycle: bind on mount, rebind without a hidden flash
  // on element swap, publish-hidden-then-dispose on unmount.
  const anchorRef = useCallback(
    (el: HTMLDivElement | null) => {
      const existing = anchorHandleRef.current
      if (existing) {
        if (el) {
          existing.dispose()
          anchorHandleRef.current = createViewAnchor(el, {
            visible: true,
            treatZeroAreaAsHidden: true,
            followScroll: true,
            followGeometry: true,
            publish,
          })
        } else {
          existing.update({ visible: false, publish })
          existing.dispose()
          anchorHandleRef.current = null
        }
        return
      }
      if (el) {
        anchorHandleRef.current = createViewAnchor(el, {
          visible: true,
          treatZeroAreaAsHidden: true,
          followScroll: true,
          followGeometry: true,
          publish,
        })
      }
    },
    [publish],
  )

  const layoutEpoch = useDockLayoutEpoch()
  useLayoutEffect(() => {
    anchorHandleRef.current?.update({
      visible: true,
      treatZeroAreaAsHidden: true,
      followScroll: true,
      followGeometry: true,
      publish,
    })
  }, [layoutEpoch, publish])

  // Hard-unmount safety: the ref-callback `null` cleanup also disposes, but a
  // teardown that skips the ref cleanup must not leak a live anchor.
  useEffect(() => {
    return () => {
      anchorHandleRef.current?.dispose()
      anchorHandleRef.current = null
      publisher?.remove(VIEW_ID.workbench)
    }
  }, [publisher])

  return <div ref={anchorRef} className="h-full w-full" data-area="editor" data-deck-viewport />
}
