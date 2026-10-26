import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'

type Bounds = { left: number; top: number; width: number; height: number }
type Edges = { left: boolean; right: boolean; top: boolean; bottom: boolean }
type Drag = { pointerId: number; x: number; y: number; bounds: Bounds; edges: Edges; moving: boolean; target: HTMLDivElement }

const MARGIN = 16
const EDGE = 6

function fit(bounds: Bounds): Bounds {
  const width = Math.min(bounds.width, Math.max(1, window.innerWidth - MARGIN * 2))
  const height = Math.min(bounds.height, Math.max(1, window.innerHeight - MARGIN * 2))
  return {
    width,
    height,
    left: Math.max(0, Math.min(Math.max(MARGIN, bounds.left), window.innerWidth - MARGIN - width)),
    top: Math.max(0, Math.min(Math.max(MARGIN, bounds.top), window.innerHeight - MARGIN - height)),
  }
}

function edgesAt(element: HTMLElement, x: number, y: number): Edges {
  const rect = element.getBoundingClientRect()
  return {
    left: Math.abs(x - rect.left) <= EDGE,
    right: Math.abs(x - rect.right) <= EDGE,
    top: Math.abs(y - rect.top) <= EDGE,
    bottom: Math.abs(y - rect.bottom) <= EDGE,
  }
}

function cursorFor(edges: Edges): CSSProperties['cursor'] {
  if ((edges.left && edges.top) || (edges.right && edges.bottom)) return 'nwse-resize'
  if ((edges.right && edges.top) || (edges.left && edges.bottom)) return 'nesw-resize'
  if (edges.left || edges.right) return 'ew-resize'
  if (edges.top || edges.bottom) return 'ns-resize'
  return undefined
}

/** Pointer capture keeps movement and resizing attached until release or cancellation. */
export function useDialogResize() {
  const [bounds, setBounds] = useState<Bounds | null>(null)
  const [cursor, setCursor] = useState<CSSProperties['cursor']>()
  const drag = useRef<Drag | null>(null)
  useEffect(() => {
    const releaseDrag = () => {
      const active = drag.current
      drag.current = null
      if (active?.target.hasPointerCapture(active.pointerId)) {
        active.target.releasePointerCapture(active.pointerId)
      }
    }
    const onResize = () => {
      releaseDrag()
      setCursor(undefined)
      setBounds((current) => current ? fit(current) : null)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      releaseDrag()
    }
  }, [])

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.button !== 0 || drag.current) return
    const edges = edgesAt(event.currentTarget, event.clientX, event.clientY)
    const target = event.target instanceof Element ? event.target : null
    const header = target?.closest('[data-dialog-drag-handle]')
    const moving = !cursorFor(edges) && !!header && event.currentTarget.contains(header)
      && !target?.closest('button, input, textarea, select, a, [role="button"], [contenteditable]')
    if (!cursorFor(edges) && !moving) return
    const rect = event.currentTarget.getBoundingClientRect()
    const initial = fit({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, bounds: initial, edges, moving, target: event.currentTarget }
    event.currentTarget.setPointerCapture(event.pointerId)
    setBounds(initial)
    setCursor(moving ? 'grabbing' : cursorFor(edges))
    event.preventDefault()
    event.stopPropagation()
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const active = drag.current
    if (!active) {
      setCursor(cursorFor(edgesAt(event.currentTarget, event.clientX, event.clientY)))
      return
    }
    if (active.pointerId !== event.pointerId) return
    const initial = active.bounds
    const dx = event.clientX - active.x
    const dy = event.clientY - active.y
    if (active.moving) {
      setBounds(fit({ ...initial, left: initial.left + dx, top: initial.top + dy }))
      event.preventDefault()
      event.stopPropagation()
      return
    }
    const minWidth = Math.min(240, initial.width)
    const minHeight = Math.min(160, initial.height)
    const right = initial.left + initial.width
    const bottom = initial.top + initial.height
    const left = active.edges.left ? Math.max(MARGIN, Math.min(initial.left + dx, right - minWidth)) : initial.left
    const top = active.edges.top ? Math.max(MARGIN, Math.min(initial.top + dy, bottom - minHeight)) : initial.top
    const width = active.edges.left ? right - left : active.edges.right
      ? Math.min(window.innerWidth - MARGIN - left, Math.max(minWidth, initial.width + dx)) : initial.width
    const height = active.edges.top ? bottom - top : active.edges.bottom
      ? Math.min(window.innerHeight - MARGIN - top, Math.max(minHeight, initial.height + dy)) : initial.height
    setBounds(fit({ left, top, width, height }))
    event.preventDefault()
    event.stopPropagation()
  }

  function onPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setCursor(undefined)
  }

  const style: CSSProperties = bounds
    ? { ...bounds, maxWidth: 'none', maxHeight: 'none', transform: 'none', translate: 'none', transition: 'none', cursor }
    : { cursor }
  return { style, onPointerDown, onPointerMove, onPointerEnd }
}
