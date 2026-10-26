/**
 * The card's icon tile and its per-card actions.
 *
 * The icon tile has three states that are easy to collapse into two by
 * accident: a real image, the name-initial text logo, and the initial again
 * after a user-typed URL fails to load. The last one is what keeps a typo'd
 * or offline icon from leaving a blank square.
 *
 * The action buttons sit on top of a card whose whole surface opens the
 * project, so each one has to stop the click from reaching that handler.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProjectCard } from './project-card'

const project = { name: 'Alpha', path: '/path/alpha', lastOpened: null }

function renderCard(overrides: Partial<Parameters<typeof ProjectCard>[0]> = {}) {
  return render(
    <ProjectCard
      project={project}
      onOpen={() => {}}
      onRemove={() => {}}
      {...overrides}
    />,
  )
}

describe('ProjectCard icon', () => {
  it('shows the name initial when the project has no iconUrl', () => {
    const { container } = renderCard()
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
  })

  it('shows an <img> with the icon URL instead of the initial', () => {
    const { container } = renderCard({
      project: { ...project, iconUrl: 'https://cdn.example.com/a.png' },
    })
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe('https://cdn.example.com/a.png')
    expect(screen.queryByText('A')).not.toBeInTheDocument()
  })

  it('falls back to the initial when the icon URL fails to load', () => {
    const { container } = renderCard({
      project: { ...project, iconUrl: 'https://cdn.example.com/missing.png' },
    })
    fireEvent.error(container.querySelector('img')!)
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
  })
})

describe('ProjectCard actions', () => {
  it('calls onEdit with the project and does not open it', () => {
    const onEdit = vi.fn()
    const onOpen = vi.fn()
    const { container } = renderCard({ onEdit, onOpen })

    fireEvent.mouseEnter(container.firstElementChild!)
    fireEvent.click(screen.getByRole('button', { name: '编辑 Alpha' }))

    expect(onEdit).toHaveBeenCalledWith(project)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('hides the edit action when the host supplies no onEdit', () => {
    const { container } = renderCard()
    fireEvent.mouseEnter(container.firstElementChild!)
    expect(screen.queryByRole('button', { name: '编辑 Alpha' })).not.toBeInTheDocument()
    // The remove action stays — the two are independent.
    expect(screen.getByTitle('移除')).toBeInTheDocument()
  })
})

describe('ProjectCard opening', () => {
  it('opens when the existing project content container is clicked', () => {
    const onOpen = vi.fn()
    renderCard({ onOpen, onEdit: vi.fn() })

    fireEvent.click(screen.getByTitle(project.path).parentElement!)

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '打开 Alpha' })).toHaveAttribute('type', 'button')
  })

  it('exposes a keyboard-reachable open button without nesting actions inside it', () => {
    const onOpen = vi.fn()
    const { container } = renderCard({ onOpen, onEdit: vi.fn() })
    const open = screen.getByRole('button', { name: '打开 Alpha' })
    expect(open).toHaveClass('focus-visible:ring-2')
    expect(open.closest('[data-project-card]')).toBe(container.firstElementChild)
    fireEvent.click(open)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith(project)
    expect(open.querySelector('[data-project-card-actions]')).toBeNull()
  })

  it('keeps edit and remove actions independent from the main open button', () => {
    const onOpen = vi.fn()
    const onEdit = vi.fn()
    const onRemove = vi.fn()
    const { container } = renderCard({ onOpen, onEdit, onRemove })

    fireEvent.mouseEnter(container.firstElementChild!)
    fireEvent.click(screen.getByRole('button', { name: '编辑 Alpha' }))
    fireEvent.click(screen.getByTitle('移除'))

    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe('ProjectCard semantic surface', () => {
  it('uses the card surface and WeChat-compatible preview geometry', () => {
    const { container } = renderCard()
    const card = container.querySelector('[data-project-card]')
    expect(card).toHaveClass('bg-card', 'text-card-foreground', 'rounded-xl', 'shadow', 'hover:border-primary')
    expect(card).not.toHaveClass('hover:border-primary/60')
    expect(card?.querySelector('[data-project-card-media]')).toHaveClass('aspect-[44/45]')
    expect(card?.querySelector('[data-project-card-actions]')).toHaveClass('bg-transparent')
  })
})
