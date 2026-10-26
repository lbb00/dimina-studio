import { type ReactNode, useEffect, useState } from 'react'
import { Pencil } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Card } from '@/shared/components/ui/card'
import { formatLastOpened } from '@/shared/lib/utils'
import type { Project } from '../types'

/**
 * The preview matches the 176×180 cover area in WeChat Developer Tools.
 * The data attribute lets visual tests measure the user-visible preview.
 */
export function ProjectCardMedia({ children }: { children?: ReactNode }) {
  return (
    <div data-project-card-media className="aspect-[44/45] w-full overflow-hidden rounded-t-xl bg-muted">
      {children}
    </div>
  )
}

/**
 * The metadata block under the preview. The minimum height keeps the create
 * card aligned with real cards while the grid remains fluid.
 */
export function ProjectCardFooter({
  icon,
  iconUrl,
  name,
  path,
  meta,
}: {
  icon?: ReactNode
  /** When set, the icon tile shows this image instead of `icon`. */
  iconUrl?: string
  name?: string
  path?: string
  meta?: ReactNode
}) {
  return (
    <div className="relative flex min-h-[136px] flex-col gap-2 p-4 shrink-0">
      <ProjectCardIcon iconUrl={iconUrl} fallback={icon} />
      <div className="flex min-w-0 flex-col gap-1">
        <div
          className="truncate text-sm font-medium leading-5 text-card-foreground"
          title={name}
        >
          {name ?? ' '}
        </div>
        <div
          className="truncate text-xs leading-4 text-muted-foreground"
          title={path}
        >
          {path ?? ' '}
        </div>
      </div>
      <div className="text-xs leading-4 text-muted-foreground">
        {meta ?? ' '}
      </div>
    </div>
  )
}

/**
 * The icon tile in a card's footer. With an `iconUrl` it shows that
 * image; otherwise (and after the image fails to load) it shows `fallback` —
 * the name-initial text logo — on the solid brand tile.
 *
 * The tile keeps its size and shape in both modes so a card does not reflow
 * when a project gains or loses an icon. The load-failure fallback matters
 * because the URL is user-typed and points at a remote host: without it a
 * typo or an offline host leaves a blank square with no way to tell it apart
 * from a project that simply has no icon. The fallback uses the semantic
 * primary surface so it stays neutral in both color schemes.
 */
function ProjectCardIcon({
  iconUrl,
  fallback,
}: {
  iconUrl?: string
  fallback?: ReactNode
}) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [iconUrl])
  const showImage = !!iconUrl && !failed

  return (
    <div
      className={`size-10 shrink-0 overflow-hidden rounded-md flex items-center justify-center text-lg font-medium leading-none ${
        showImage
          ? 'bg-muted'
          : fallback
            ? 'bg-primary text-primary-foreground'
            : ''
      }`}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          src={iconUrl}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        fallback
      )}
    </div>
  )
}

/** First grapheme of the project name, upper-cased for Latin script — used as
 * a text-logo fallback when the project has no real icon/thumbnail. */
function initialOf(name: string): string {
  const first = Array.from(name.trim())[0]
  return first ? first.toUpperCase() : '?'
}

export function ProjectCard({
  project: p,
  onOpen,
  onEdit,
  onRemove,
  thumbnail,
}: {
  project: Project
  onOpen: (p: Project) => void
  /** Omitted by hosts that don't expose the edit dialog — the pencil is then hidden. */
  onEdit?: (p: Project) => void
  onRemove: (p: Project) => void
  thumbnail?: string | null
}) {
  return (
    <Card
      data-project-card
      role="article"
      className="group relative min-w-[240px] w-full cursor-pointer overflow-hidden transition-colors duration-150 hover:border-primary hover:shadow-md"
    >
      <button
        type="button"
        aria-label={`打开 ${p.name}`}
        data-project-card-open
        className="relative flex w-full min-w-[240px] flex-col text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={() => onOpen(p)}
      >
        <ProjectCardMedia>
          {thumbnail ? (
            <img src={thumbnail} className="size-full bg-muted object-cover object-top" alt="" />
          ) : (
            <div className="size-full bg-muted" />
          )}
        </ProjectCardMedia>
        <ProjectCardFooter
          icon={initialOf(p.name)}
          iconUrl={p.iconUrl}
          name={p.name}
          path={p.path}
          meta={formatLastOpened(p.lastOpened)}
        />
      </button>
      {/* Stays in the DOM at all times — keyboard focus (Tab) has to reach
          these buttons, which a hover-gated mount would block. Visibility is
          CSS-only: opacity-0 by default, revealed by group-hover for pointer
          users and focus-within so a tabbed-into button doesn't disappear
          once the mouse isn't over the card. */}
      <div data-project-card-actions className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md bg-transparent opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {onEdit && (
          <Button
            size="icon-sm"
            variant="icon"
            className="size-7 bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            onClick={(e) => {
              e.stopPropagation()
              onEdit(p)
            }}
            title="编辑"
            aria-label={`编辑 ${p.name}`}
          >
            <Pencil className="size-3" aria-hidden="true" />
          </Button>
        )}
        <Button
          variant="danger"
          size="icon-sm"
          className="size-7 bg-transparent text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
          onClick={(e) => {
            e.stopPropagation()
            onRemove(p)
          }}
          title="移除"
        >
          ×
        </Button>
      </div>
    </Card>
  )
}
