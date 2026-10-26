/**
 * Built-in "新建小程序" dialog. Two independent inputs (项目名 + 目录) plus a
 * template-card grid. Renders nothing when `open` is false so the parent
 * can mount it unconditionally.
 *
 * The directory field is *suggested* from the project name + a base
 * directory (last-used parent, or platform default). It stays in sync with
 * the name until the user manually edits the path or picks a directory
 * with 浏览; from then on it's pinned and stops following the name.
 */
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/shared/components/ui/dialog'

export interface ProjectTemplateInfo {
  id: string
  name: string
  description?: string
}

export interface ProjectCreateDialogProps {
  open: boolean
  pending?: boolean
  templates: ProjectTemplateInfo[]
  /**
   * Parent directory used to compose the suggested target path. If empty,
   * the dialog suggests just the project-name slug (the user must point
   * 浏览 at a real location). Provide an absolute path on macOS/Linux.
   */
  defaultBaseDir?: string
  onSubmit: (input: {
    name: string
    path: string
    templateId: string
  }) => void
  onCancel: () => void
  onBrowse: () => Promise<string | null>
}

/**
 * Project-name → directory-name. Strips characters that aren't safe in a
 * filesystem segment on the common platforms (macOS/Linux/Windows). Keeps
 * CJK and unicode letters; collapses whitespace and runs of separators.
 */
export function slugifyDirName(name: string): string {
  return name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
}

function joinBase(base: string, leaf: string): string {
  if (!leaf) return ''
  if (!base) return leaf
  return base.endsWith('/') ? `${base}${leaf}` : `${base}/${leaf}`
}

export function ProjectCreateDialog(
  props: ProjectCreateDialogProps,
): React.ReactElement | null {
  const { open, templates, defaultBaseDir, onSubmit, onCancel, onBrowse, pending = false } = props
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const requiredFieldsHintId = React.useId()
  const [templateId, setTemplateId] = useState<string>(
    templates[0]?.id ?? 'blank',
  )
  // `path` keeps following `name` until the user edits the path directly
  // (typing or 浏览). The ref avoids re-renders that an extra state would
  // cause when name changes rapidly.
  const manualPathRef = useRef(false)

  // Re-seed the default template selection whenever the supplied catalog
  // changes (e.g. host injected a new list). If the current selection is
  // still in the list, keep it; otherwise fall back to the first.
  useEffect(() => {
    if (!templates.find((t) => t.id === templateId)) {
      setTemplateId(templates[0]?.id ?? 'blank')
    }
  }, [templates, templateId])

  // Reset to a clean slate every time the dialog opens so the previous
  // session's inputs don't bleed through.
  useEffect(() => {
    if (open) {
      setName('')
      setPath('')
      manualPathRef.current = false
    }
  }, [open])

  const canSubmit = name.trim().length > 0 && path.trim().length > 0

  function handleNameChange(next: string) {
    setName(next)
    if (!manualPathRef.current) {
      const slug = slugifyDirName(next)
      setPath(slug ? joinBase(defaultBaseDir ?? '', slug) : '')
    }
  }

  function handlePathChange(next: string) {
    manualPathRef.current = true
    setPath(next)
  }

  async function handleBrowse() {
    const picked = await onBrowse()
    if (picked) {
      manualPathRef.current = true
      setPath(picked)
    }
  }

  function handleSubmit() {
    if (!canSubmit || pending) return
    onSubmit({ name: name.trim(), path: path.trim(), templateId })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel() }}>
      <DialogContent className="w-[560px] max-w-[90vw]">
        <DialogHeader>
          <DialogTitle>新建小程序</DialogTitle>
          <DialogDescription>填写项目基本信息并选择一个模板。</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-6">
          <label className="flex flex-col gap-2 text-[13px]">
            <span className="font-medium text-foreground">项目名</span>
            <Input
              aria-label="项目名"
              aria-describedby={requiredFieldsHintId}
              required
              disabled={pending}
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="例如：My App"
              className="h-8"
            />
          </label>

          <label className="flex flex-col gap-2 text-[13px]">
            <span className="font-medium text-foreground">目录</span>
            <div className="flex gap-2">
              <Input
                aria-label="目录"
                aria-describedby={requiredFieldsHintId}
                required
                disabled={pending}
                value={path}
                onChange={(e) => handlePathChange(e.target.value)}
                placeholder="/absolute/path/to/dir"
                className="flex-1 h-8"
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleBrowse}
                disabled={pending}
                className="h-8 px-2.5 text-[13px]"
              >
                浏览
              </Button>
            </div>
          </label>

          <p id={requiredFieldsHintId} className="text-xs text-muted-foreground">
            项目名称和目录均为必填项。
          </p>

          <div className="flex flex-col gap-2 text-[13px]">
            <span className="font-medium text-foreground">模板</span>
            <div
              className="grid gap-3"
              style={{
                gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 160px), 1fr))',
              }}
            >
              {templates.map((t) => {
                const active = t.id === templateId
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTemplateId(t.id)}
                    disabled={pending}
                    className={[
                      'flex flex-col gap-2 rounded-lg border px-3 py-4 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active
                        ? 'border-primary bg-accent'
                        : 'border-border bg-card hover:border-primary',
                    ].join(' ')}
                    aria-pressed={active}
                  >
                    <div className="text-sm font-medium text-card-foreground">{t.name}</div>
                    {t.description ? (
                      <div className="text-xs leading-4 text-muted-foreground">
                        {t.description}
                      </div>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            className="h-9 px-2.5 text-[15px]"
          >
            取消
          </Button>
          <Button
            type="button"
            variant="default"
            onClick={handleSubmit}
            disabled={!canSubmit || pending}
            aria-describedby={requiredFieldsHintId}
            className="h-9 px-2.5 text-[15px]"
          >
            创建并打开
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
