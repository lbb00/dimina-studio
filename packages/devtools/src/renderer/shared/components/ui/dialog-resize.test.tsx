import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './dialog'

class TestPointerEvent extends MouseEvent {
  pointerId: number
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 1
  }
}

beforeEach(() => {
  vi.stubGlobal('PointerEvent', TestPointerEvent)
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(800)
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const element = this as HTMLElement
    const left = Number.parseFloat(element.style.left) || 100
    const top = Number.parseFloat(element.style.top) || 80
    const width = Number.parseFloat(element.style.width) || 400
    const height = Number.parseFloat(element.style.height) || 300
    return DOMRect.fromRect({ x: left, y: top, width, height })
  })
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true)
  HTMLElement.prototype.releasePointerCapture = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function show(open = true) {
  return <Dialog open={open}><DialogContent aria-describedby={undefined}><DialogTitle>编辑</DialogTitle><input aria-label="名称" /></DialogContent></Dialog>
}

function drag(dialog: HTMLElement, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(dialog, { clientX: from[0], clientY: from[1], button: 0, pointerId: 7 })
  fireEvent.pointerMove(dialog, { clientX: to[0], clientY: to[1], pointerId: 7 })
  fireEvent.pointerUp(dialog, { pointerId: 7 })
}

describe('dialog edge resizing', () => {
  it.each([
    { edge: 'right', from: [500, 200], to: [650, 200], expected: { left: '100px', width: '550px' } },
    { edge: 'left', from: [100, 200], to: [150, 200], expected: { left: '150px', width: '350px' } },
    { edge: 'bottom', from: [200, 380], to: [200, 450], expected: { top: '80px', height: '370px' } },
    { edge: 'top', from: [200, 80], to: [200, 110], expected: { top: '110px', height: '270px' } },
  ])('resizes from the $edge edge while keeping the opposite edge in place', ({ from, to, expected }) => {
    render(show())
    const dialog = screen.getByRole('dialog')
    drag(dialog, from as [number, number], to as [number, number])
    expect(dialog).toHaveStyle(expected)
    expect(dialog.releasePointerCapture).toHaveBeenCalledWith(7)
  })

  it('limits a corner resize to the viewport and keeps the dialog reachable after the window shrinks', () => {
    render(show())
    const dialog = screen.getByRole('dialog')
    drag(dialog, [500, 380], [1200, 900])
    expect(dialog).toHaveStyle({ left: '100px', top: '80px', width: '684px', height: '504px' })
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(360)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(240)
    fireEvent(window, new Event('resize'))
    expect(dialog).toHaveStyle({ left: '16px', top: '16px', width: '328px', height: '208px' })
  })

  it('stops a cancelled drag and starts a fresh drag independently', () => {
    render(show())
    const dialog = screen.getByRole('dialog')
    fireEvent.pointerDown(dialog, { clientX: 500, clientY: 200, button: 0, pointerId: 7 })
    fireEvent.pointerMove(dialog, { clientX: 540, clientY: 200, pointerId: 7 })
    fireEvent.pointerCancel(dialog, { pointerId: 7 })
    fireEvent.pointerMove(dialog, { clientX: 600, clientY: 200, pointerId: 7 })
    expect(dialog).toHaveStyle({ width: '440px' })
    drag(dialog, [540, 200], [560, 200])
    expect(dialog).toHaveStyle({ width: '460px' })
  })

  it('resets a resized dialog when closed and reopened', () => {
    const view = render(show())
    drag(screen.getByRole('dialog'), [500, 200], [600, 200])
    view.rerender(show(false))
    expect(screen.queryByRole('dialog')).toBeNull()
    view.rerender(show())
    expect(screen.getByRole('dialog').style.width).toBe('')
  })

  it('preserves the forwarded ref, caller styles and normal input pointer events', () => {
    const ref = createRef<HTMLDivElement>()
    const onPointerDownCapture = vi.fn()
    render(<Dialog open><DialogContent aria-describedby={undefined} ref={ref} style={{ backgroundColor: 'red' }} onPointerDownCapture={onPointerDownCapture}>
      <DialogTitle>编辑</DialogTitle><input aria-label="名称" />
    </DialogContent></Dialog>)
    const dialog = screen.getByRole('dialog')
    fireEvent.pointerDown(screen.getByRole('textbox'), { clientX: 250, clientY: 200, button: 0, pointerId: 1 })
    expect(ref.current).toBe(dialog)
    expect(dialog).toHaveStyle({ backgroundColor: 'rgb(255, 0, 0)' })
    expect(onPointerDownCapture).toHaveBeenCalledOnce()
    expect(dialog.setPointerCapture).not.toHaveBeenCalled()
    expect(dialog.style.width).toBe('')
  })
})


describe('dialog title dragging', () => {
  it('moves from the header, clamps to the viewport, preserves size and resets on reopen', () => {
    const content = (open: boolean) => <Dialog open={open}><DialogContent aria-describedby={undefined}>
      <DialogHeader><DialogTitle>移动弹窗</DialogTitle><button>标题操作</button></DialogHeader>
      <input aria-label="名称" />
    </DialogContent></Dialog>
    const view = render(content(true))
    const dialog = screen.getByRole('dialog')
    const header = screen.getByText('移动弹窗')
    drag(header, [200, 120], [260, 160])
    expect(dialog).toHaveStyle({ left: '160px', top: '120px', width: '400px', height: '300px' })
    drag(header, [260, 160], [2000, 2000])
    expect(dialog).toHaveStyle({ left: '384px', top: '284px', width: '400px', height: '300px' })
    view.rerender(content(false))
    view.rerender(content(true))
    expect(screen.getByRole('dialog').style.left).toBe('')
  })

  it('does not capture controls inside the header', () => {
    render(<Dialog open><DialogContent aria-describedby={undefined}><DialogHeader>
      <DialogTitle>移动弹窗</DialogTitle><button>标题操作</button>
    </DialogHeader></DialogContent></Dialog>)
    fireEvent.pointerDown(screen.getByText('标题操作'), {clientX:200, clientY:120, button:0, pointerId:7})
    expect(screen.getByRole('dialog').setPointerCapture).not.toHaveBeenCalled()
  })
})
