import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { invokeStrict, on as ipcOn, send } from '@/shared/api/ipc-transport'
import { notifyOverlayReady } from '@/shared/api'
import { UpdateChannel } from '../../../shared/ipc-channels-overlays.js'
import { isSameUpdateInfo, type UpdateInfo } from '../../../shared/update-checker-types.js'

// Update dialog uses `invokeStrict` (rejects on error) so a failed download
// surfaces as an "error" stage instead of being silently swallowed by the
// default invoke wrapper. `ipcOn` is the renderer-side subscribe helper that
// funnels through the same preload bridge as every other facade in this
// folder, keeping update-dialog inside the typed transport boundary that
// the renderer eslint rule enforces.

type Stage = 'prompt' | 'downloading' | 'ready' | 'error'

export function UpdateDialog() {
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [stage, setStage] = useState<Stage>('prompt')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const downloadRequest = useRef(0)
  // Which action produced the current error stage — the 'error' stage is
  // shared between handleDownload and handleInstall so the description text
  // and the Retry button's target action stay correct for whichever failed.
  const [failedAction, setFailedAction] = useState<'download' | 'install'>('download')

  // These two subscriptions must be registered BEFORE notifyOverlayReady()
  // fires below — main can respond to the ready notification by pushing a
  // pending Available synchronously, and React runs effects in declaration
  // order on mount, so a notifyOverlayReady() effect declared first could
  // win that race and permanently leave `info` null (dialog invisible, but
  // its WCV still consuming input) for a case that raced.
  useEffect(() => {
    return ipcOn<[UpdateInfo]>(UpdateChannel.Available, (updateInfo) => {
      if (!isSameUpdateInfo(info, updateInfo)) downloadRequest.current += 1
      setInfo(updateInfo)
      setStage(updateInfo.downloadState?.stage ?? 'prompt')
      setProgress(updateInfo.downloadState?.progress ?? 0)
      setError(updateInfo.downloadState?.error ?? '')
      setOpen(true)
    })
  }, [info])

  useEffect(() => {
    return ipcOn<[{ percent: number }]>(UpdateChannel.DownloadProgress, (data) => {
      setProgress(Math.round(data.percent))
    })
  }, [])

  // Announce readiness once on mount so main's manual-readyMode overlay
  // panel knows this WCV finished installing its listeners and can attach
  // the pending show() (see createOverlayPanel's markReady gate).
  useEffect(() => {
    notifyOverlayReady()
  }, [])

  const handleDownload = useCallback(async () => {
    const request = ++downloadRequest.current
    setStage('downloading')
    setProgress(0)
    try {
      const result = await invokeStrict<{
        success: boolean
        error?: string
      }>(UpdateChannel.Download)
      if (request !== downloadRequest.current) return
      if (result.success) {
        setStage('ready')
      } else {
        setError(result.error || 'Download failed')
        setFailedAction('download')
        setStage('error')
      }
    } catch (err) {
      if (request !== downloadRequest.current) return
      setError(err instanceof Error ? err.message : String(err))
      setFailedAction('download')
      setStage('error')
    }
  }, [])

  const handleInstall = useCallback(async () => {
    try {
      const result = await invokeStrict<{ success: boolean; error?: string }>(UpdateChannel.Install)
      if (!result.success) {
        setError(result.error || 'Install failed')
        setFailedAction('install')
        setStage('error')
      }
      // On success the main process calls app.quit() right after resolving —
      // no further renderer state transition needed, the app is closing.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setFailedAction('install')
      setStage('error')
    }
  }, [])

  // Closing (either path below) must tell main to hide the overlay panel —
  // `setOpen(false)` only unmounts this renderer's own DOM, it never touches
  // the WebContentsView main keeps presented, which otherwise stays up
  // forever as an invisible click-eating overlay.
  const handleClose = useCallback(() => {
    if (info?.mandatory && stage !== 'ready') return
    setOpen(false)
    send(UpdateChannel.Close)
  }, [info, stage])

  if (!info) return null

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && info?.mandatory && stage !== 'ready') return
        setOpen(v)
        if (!v) send(UpdateChannel.Close)
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {stage === 'ready' ? 'Ready to Install' : 'Update Available'}
          </DialogTitle>
          <DialogDescription>
            {stage === 'prompt' && `New version ${info.version} is available.`}
            {stage === 'downloading' && `Downloading... ${progress}%`}
            {stage === 'ready' && 'Download complete. Click install to restart and apply the update.'}
            {stage === 'error' && `${failedAction === 'install' ? 'Install' : 'Download'} failed: ${error}`}
          </DialogDescription>
        </DialogHeader>

        {info.releaseNotes && stage === 'prompt' && (
          <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-muted p-3 text-xs text-foreground whitespace-pre-wrap">
            {info.releaseNotes}
          </div>
        )}

        {stage === 'downloading' && (
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        <DialogFooter>
          {stage === 'prompt' && (
            <>
              {!info.mandatory && (
                <Button variant="outline" onClick={handleClose}>
                  Later
                </Button>
              )}
              <Button onClick={handleDownload}>Download</Button>
            </>
          )}
          {stage === 'ready' && (
            <Button onClick={handleInstall}>Install & Restart</Button>
          )}
          {stage === 'error' && (
            <>
              <Button variant="outline" onClick={handleClose}>
                Close
              </Button>
              <Button onClick={failedAction === 'install' ? handleInstall : handleDownload}>Retry</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
