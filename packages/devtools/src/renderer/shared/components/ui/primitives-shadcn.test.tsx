import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Button } from './button'
import { Card } from './card'
import { Dialog, DialogContent, DialogTitle } from './dialog'
import { Input } from './input'
import { Select, SelectTrigger } from './select'
import { Sheet, SheetContent, SheetTitle } from './sheet'
import { Switch } from './switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterAll(() => vi.unstubAllGlobals())

describe('new-york primitive contracts', () => {
  it('keeps the default button on the official new-york contract', () => {
    render(<Button>保存</Button>)
    const button = screen.getByRole('button', { name: '保存' })
    expect(button).toHaveClass(
      'gap-2',
      'text-sm',
      'transition-colors',
      'focus-visible:outline-none',
      'focus-visible:ring-1',
      'focus-visible:ring-ring',
      'shadow',
    )
    expect(button).toHaveClass('[&_svg]:size-4')
    expect(button).not.toHaveClass('transition-all', 'shadow-sm')
  })

  it('uses a shadcn foreground pair for the soft button state', () => {
    render(<Button variant="soft">稍后</Button>)
    const button = screen.getByRole('button', { name: '稍后' })
    expect(button).toHaveClass('bg-secondary', 'text-secondary-foreground', 'hover:bg-secondary/80')
    expect(button).not.toHaveClass('bg-primary/10', 'text-primary', 'hover:bg-primary/20')
  })

  it('keeps the destructive button pair opaque on hover', () => {
    render(<Button variant="destructive">移除</Button>)
    const button = screen.getByRole('button', { name: '移除' })
    expect(button).toHaveClass('bg-destructive', 'text-destructive-foreground', 'hover:bg-destructive')
    expect(button).not.toHaveClass('hover:bg-destructive/90')
  })

  it('keeps the default card shadow on the official new-york contract', () => {
    const { container } = render(<Card>项目</Card>)
    expect(container.firstElementChild).toHaveClass(
      'rounded-xl',
      'border',
      'bg-card',
      'text-card-foreground',
      'shadow',
    )
    expect(container.firstElementChild).not.toHaveClass('shadow-sm')
  })

  it('keeps the input height, file styles, and focus ring on the official new-york contract', () => {
    render(<Input aria-label="名称" />)
    expect(screen.getByRole('textbox', { name: '名称' })).toHaveClass(
      'h-9',
      'bg-transparent',
      'transition-colors',
      'file:border-0',
      'file:bg-transparent',
      'file:text-sm',
      'file:font-medium',
      'focus-visible:outline-none',
      'focus-visible:ring-1',
      'focus-visible:ring-ring',
    )
  })

  it('uses an accessible shadcn segmented control by default', () => {
    render(
      <Tabs defaultValue="one">
        <TabsList><TabsTrigger value="one">一</TabsTrigger></TabsList>
        <TabsContent value="one">内容</TabsContent>
      </Tabs>,
    )
    const list = screen.getByRole('tablist')
    expect(list).toHaveClass('h-9', 'rounded-lg', 'bg-muted', 'text-foreground', 'p-1')
    expect(list).not.toHaveClass('border-b')
    expect(screen.getByRole('tab', { name: '一' })).toHaveClass(
      'transition-all',
      'focus-visible:ring-2',
      'focus-visible:ring-offset-2',
      'data-[state=active]:shadow',
    )
    expect(screen.getByText('内容')).toHaveClass(
      'mt-2',
      'focus-visible:ring-2',
      'focus-visible:ring-offset-2',
    )
  })

  it('keeps the switch geometry and focus treatment on the official new-york contract', () => {
    render(<Switch aria-label="启用" />)
    const switchRoot = screen.getByRole('switch', { name: '启用' })
    expect(switchRoot).toHaveClass(
      'h-5',
      'w-9',
      'border-2',
      'transition-colors',
      'focus-visible:ring-2',
      'focus-visible:ring-offset-2',
      'focus-visible:ring-offset-background',
      'data-[state=unchecked]:bg-input',
    )
    expect(switchRoot.firstElementChild).toHaveClass(
      'h-4',
      'w-4',
      'bg-background',
      'shadow-lg',
      'data-[state=checked]:translate-x-4',
    )
  })

  it('uses the standard primary tooltip surface without a custom arrow', () => {
    render(
      <Tooltip defaultOpen delayDuration={0}>
        <TooltipTrigger>触发器</TooltipTrigger>
        <TooltipContent>提示</TooltipContent>
      </Tooltip>,
    )
    const tooltip = screen.getAllByText('提示').find((node) => node.hasAttribute('data-side'))
    expect(tooltip).toBeDefined()
    expect(tooltip!).toHaveClass('bg-primary', 'text-primary-foreground')
    expect(tooltip!).not.toHaveClass('bg-popover', 'text-popover-foreground', 'shadow-md')
    expect(tooltip!.querySelector('svg')).toBeNull()
  })

  it('uses the standard select trigger layout and focus contract', () => {
    render(
      <Select>
        <SelectTrigger aria-label="缩放" />
      </Select>,
    )
    expect(screen.getByRole('combobox', { name: '缩放' })).toHaveClass(
      'h-9',
      'whitespace-nowrap',
      'py-2',
      'ring-offset-background',
      'focus-visible:ring-2',
      'focus-visible:ring-ring',
      '[&>span]:line-clamp-1',
    )
  })

  it('keeps dialog placement, animation, and close focus on the official new-york contract', () => {
    render(
      <Dialog defaultOpen>
        <DialogContent><DialogTitle>编辑项目</DialogTitle></DialogContent>
      </Dialog>,
    )
    expect(screen.getByRole('dialog')).toHaveClass(
      'fixed',
      'left-[50%]',
      'top-[50%]',
      'grid',
      'translate-x-[-50%]',
      'translate-y-[-50%]',
      'duration-200',
      'sm:rounded-lg',
    )
    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass(
      'opacity-70',
      'ring-offset-background',
      'focus:ring-2',
      'focus:ring-offset-2',
    )
  })

  it('keeps sheet motion and close focus on the official new-york contract', () => {
    render(
      <Sheet defaultOpen>
        <SheetContent side="right"><SheetTitle>设置</SheetTitle></SheetContent>
      </Sheet>,
    )
    expect(screen.getByRole('dialog')).toHaveClass(
      'fixed',
      'transition',
      'ease-in-out',
      'data-[state=closed]:duration-300',
      'data-[state=open]:duration-500',
      'border-l',
    )
    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass(
      'opacity-70',
      'ring-offset-background',
      'focus:ring-2',
      'focus:ring-offset-2',
    )
  })
})
