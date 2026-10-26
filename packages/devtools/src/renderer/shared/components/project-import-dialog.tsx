import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'

export interface ProjectImportDialogProps {
  open: boolean
  onClose: () => void
  onBrowse: () => Promise<string | null>
  onSubmit: (path: string) => Promise<void>
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function ProjectImportDialog({ open, onClose, onBrowse, onSubmit }: ProjectImportDialogProps) {
  const [path, setPath] = useState('')
  const [pathOrigin, setPathOrigin] = useState<'typed' | 'picker'>('typed')
  const [error, setError] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const mounted = useRef(false)
  const epoch = useRef(0)
  const browsingRef = useRef(false)
  const submittingRef = useRef(false)
  const busy = browsing || submitting

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      epoch.current += 1
    }
  }, [])

  useLayoutEffect(() => {
    epoch.current += 1
  }, [open])

  useEffect(() => {
    if (!open) {
      browsingRef.current = false
      submittingRef.current = false
      return
    }
    browsingRef.current = false
    submittingRef.current = false
    setPath('')
    setPathOrigin('typed')
    setError(null)
    setBrowsing(false)
    setSubmitting(false)
  }, [open])

  function isCurrent(requestEpoch: number) {
    return mounted.current && requestEpoch === epoch.current
  }

  function close() {
    if (submittingRef.current) return
    epoch.current += 1
    browsingRef.current = false
    onClose()
  }

  async function browse() {
    if (submittingRef.current || browsingRef.current) return
    browsingRef.current = true
    const requestEpoch = ++epoch.current
    setBrowsing(true)
    setError(null)
    try {
      const selected = await onBrowse()
      if (!isCurrent(requestEpoch) || !selected) return
      setPathOrigin('picker')
      setPath(selected)
    } catch (browseError) {
      if (isCurrent(requestEpoch)) setError(messageFrom(browseError))
    } finally {
      if (isCurrent(requestEpoch)) {
        browsingRef.current = false
        setBrowsing(false)
      }
    }
  }

  async function submit() {
    const target = pathOrigin === 'picker' ? path : path.trim()
    if (!target || submittingRef.current || browsingRef.current) return
    submittingRef.current = true
    const requestEpoch = ++epoch.current
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(target)
      if (!isCurrent(requestEpoch)) return
      epoch.current += 1
      onClose()
    } catch (submitError) {
      if (isCurrent(requestEpoch)) setError(messageFrom(submitError))
    } finally {
      if (isCurrent(requestEpoch)) {
        submittingRef.current = false
        setSubmitting(false)
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close() }}>
      <DialogContent className="w-[480px] max-w-[calc(100vw-2rem)] gap-4 p-5">
        <DialogHeader>
          <DialogTitle>导入项目</DialogTitle>
          <DialogDescription>输入或选择小程序项目的根目录。</DialogDescription>
        </DialogHeader>
        <label className="flex flex-col gap-2 text-sm">
          <span>项目目录</span>
          <Input
            aria-label="项目目录"
            value={path}
            disabled={busy}
            onChange={(event) => {
              setPathOrigin('typed')
              setPath(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.key !== 'Enter') return
              void submit()
            }}
          />
        </label>
        {error && <p role="alert" className="text-sm text-status-error">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={submitting} onClick={close}>取消</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void browse()}>选择目录</Button>
          <Button type="button" disabled={busy || !(pathOrigin === 'picker' ? path : path.trim())} onClick={() => void submit()}>导入</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
