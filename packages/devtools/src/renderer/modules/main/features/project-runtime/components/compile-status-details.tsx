import React from 'react'
import type { ProjectStatus } from '@/shared/api'
import { showCompileStatusDetails } from '@/shared/api'

type CompileDiagnostic = NonNullable<ProjectStatus['diagnostics']>[number]

export function CompileStatusDetails(props: { status: string; message: string; diagnostics?: CompileDiagnostic[]; previewStale?: boolean }) {
  const { status, message } = props
  if (status !== 'error') return <span title={message} data-testid="compile-status-message" className="max-w-28 truncate text-xs text-muted-foreground">{message}</span>
  return <button type="button" data-testid="compile-status-message" className="max-w-28 truncate text-xs text-destructive underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-ring" title={message} onClick={showCompileStatusDetails}>查看编译错误</button>
}
