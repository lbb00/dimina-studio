import { useEffect, useState } from 'react'
import { hideCompileStatusDetails, notifyOverlayReady, onCompileStatusDetailsInit, type CompileStatusDetailsPayload } from '@/shared/api'

export function CompileStatusDetailsPanel() {
  const [data, setData] = useState<CompileStatusDetailsPayload | null>(null)
  useEffect(() => {
    const off = onCompileStatusDetailsInit(setData)
    notifyOverlayReady()
    return off
  }, [])
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') hideCompileStatusDetails() }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [])
  if (!data) return null
  return <div className="flex h-full w-full items-center justify-center bg-overlay p-6"><section role="dialog" aria-modal="true" aria-label="编译错误" className="max-h-full w-full max-w-2xl overflow-auto rounded-md border bg-background p-5 shadow-xl"><div className="flex items-start justify-between gap-4"><h1 className="text-lg font-semibold text-destructive">编译错误</h1><button aria-label="关闭" onClick={hideCompileStatusDetails}>×</button></div>{data.previewStale && <p className="mt-2 text-sm">模拟器显示上次成功编译的内容。</p>}<pre className="mt-3 whitespace-pre-wrap break-words text-sm text-destructive">{data.message}</pre><ul className="mt-3 space-y-2 text-sm">{data.diagnostics.map((item, index) => <li key={`${item.source}:${item.line}:${index}`} className="break-words"><div>{item.source}:{item.line}:{item.column}</div><div>{item.message}</div></li>)}</ul></section></div>
}
