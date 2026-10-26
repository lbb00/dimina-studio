import { useState, useMemo } from 'react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { FolderInput, Search } from 'lucide-react'
import { ProjectCard } from './project-card'
import { ProjectCreateCard } from './project-create-card'
import { PROJECT_TYPE_LABEL, type Project, type ProjectType } from '../types'

export function ProjectList({
  projects,
  category,
  onAdd,
  onCreate,
  onOpen,
  onEdit,
  onRemove,
  thumbnails,
}: {
  projects: Project[]
  /** Currently selected sidebar category — drives the page title and create-card label. */
  category: ProjectType
  onAdd: () => void
  /**
   * Invoked when the always-present "新建小程序" card is clicked. The card is
   * rendered as the first item of the grid and is shown even when the
   * project list is empty.
   */
  onCreate?: () => void
  onOpen: (p: Project) => void
  /** Omitted by hosts that don't expose the edit dialog — the pencil is then hidden. */
  onEdit?: (p: Project) => void
  onRemove: (p: Project) => void
  thumbnails?: Record<string, string | null>
}) {
  const [search, setSearch] = useState('')
  const filtered = useMemo(() => {
    if (!search.trim()) return projects
    const q = search.trim().toLowerCase()
    return projects.filter(
      (p) =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.path || '').toLowerCase().includes(q)
    )
  }, [projects, search])

  const handleCreate = onCreate ?? (() => {})
  const noMatch = projects.length > 0 && filtered.length === 0

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 w-full shrink-0">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{PROJECT_TYPE_LABEL[category]}</h1>
            <p className="mt-1 text-sm text-muted-foreground">管理、导入和启动你的项目</p>
          </div>
          <Button
            variant="outline"
            onClick={onAdd}
            className="h-9 gap-2"
          >
            <FolderInput className="size-4" />
            导入
          </Button>
        </div>
        <div className="relative w-full max-w-[300px] shrink-0">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜索"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 pl-9 pr-3 text-sm"
          />
        </div>
        {noMatch ? (
          <div className="flex h-72 flex-col items-center justify-center gap-3 text-muted-foreground">
            <span className="text-5xl opacity-40">🔍</span>
            <span className="text-sm">未找到匹配的项目</span>
          </div>
        ) : (
          <div
            className="grid gap-4 w-full"
            style={{
              gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 240px), 1fr))',
            }}
          >
            {/*
              The create card is always the first item (even when projects
              is empty) so first-time users have an obvious next step.
              Search doesn't filter the create card — it's not a project.
            */}
            <ProjectCreateCard onClick={handleCreate} category={category} />
            {filtered.map((p) => (
              <ProjectCard
                key={p.path}
                project={p}
                onOpen={onOpen}
                onEdit={onEdit}
                onRemove={onRemove}
                thumbnail={thumbnails?.[p.path]}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
