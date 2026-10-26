import { useEffect, useRef, useState } from 'react'
import {
  notifyOverlayReady,
  onProjectCreateInit,
  submitProjectCreate,
  cancelProjectCreate,
  createProject,
  chooseProjectDirectory,
  type ProjectCreateShowPayload,
} from '@/shared/api'
import { ProjectCreateDialog } from '@/shared/components/project-create-dialog'

/**
 * Thin stateful shell for the top-tier native project-create overlay surface.
 * `project-create-dialog.tsx` stays a pure props/callback component; this
 * mounts it against the render request main pushes after `showProjectCreateDialog`,
 * and relays submit/cancel back to main.tsx's existing scaffold flow.
 */
export default function ProjectCreatePanel() {
  const [request, setRequest] = useState<(ProjectCreateShowPayload & { generation: number }) | null>(null)
  const generationRef = useRef(0)
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    const invalidateSession = () => { ++generationRef.current }
    const off = onProjectCreateInit((payload) => {
      pendingRef.current = false
      setPending(false)
      setRequest({ ...payload, generation: ++generationRef.current })
    })
    notifyOverlayReady()
    return () => {
      invalidateSession()
      off()
    }
  }, [])

  if (!request) return null

  function handleCancel() {
    ++generationRef.current
    pendingRef.current = false
    setPending(false)
    setRequest(null)
    cancelProjectCreate()
  }

  async function handleSubmit(input: Parameters<typeof submitProjectCreate>[0]) {
    if (pendingRef.current) return
    const generation = generationRef.current
    pendingRef.current = true
    setPending(true)
    try {
      await createProject(input)
      if (generation !== generationRef.current) return
      setRequest(null)
      submitProjectCreate(input)
    } catch {
      // The main process presents the creation error; keep the same form for retry.
    } finally {
      if (generation === generationRef.current) {
        pendingRef.current = false
        setPending(false)
      }
    }
  }

  return (
    <ProjectCreateDialog
      key={request.generation}
      open
      pending={pending}
      templates={request.templates}
      defaultBaseDir={request.defaultBaseDir}
      onSubmit={handleSubmit}
      onCancel={handleCancel}
      onBrowse={chooseProjectDirectory}
    />
  )
}
