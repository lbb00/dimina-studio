/**
 * "新建小程序" card placed at the head of the project list. Renders as a
 * dashed-border placeholder card with a "+" glyph and a Chinese label, and
 * invokes its `onClick` handler when the user clicks anywhere on it.
 *
 * Its two invisible sizing rows match a real card's preview and metadata
 * height, while the visible create action remains one uniform surface.
 */
import * as React from 'react'
import { Plus } from 'lucide-react'
import { PROJECT_TYPE_LABEL, type ProjectType } from '../types'

export function ProjectCreateCard(props: {
  onClick: () => void
  category: ProjectType
}): React.ReactElement {
  const label = `新建${PROJECT_TYPE_LABEL[props.category]}`
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={label}
      data-project-card
      className="group relative flex min-w-[240px] w-full flex-col overflow-hidden rounded-xl border border-dashed border-border bg-card text-card-foreground shadow-sm transition-colors duration-150 hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <span aria-hidden="true" className="aspect-[44/45] w-full shrink-0" />
      <span aria-hidden="true" className="min-h-[136px] w-full shrink-0" />
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground transition-colors duration-150 group-hover:text-primary">
        <Plus
          className="size-10"
          aria-hidden="true"
          strokeWidth={1.5}
        />
        <span className="text-sm font-medium">{label}</span>
      </span>
    </button>
  )
}
