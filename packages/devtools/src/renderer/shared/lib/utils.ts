/* `cn` lives in @dimina-studio/design alongside the tokens its classes reference.
   Re-exported here so the shadcn-generated components keep their conventional
   `@/shared/lib/utils` import. */
export { cn } from '@dimina-studio/design'

/** Human-readable relative time for last-opened timestamps. */
export function formatLastOpened(iso: string | null | undefined): string {
  if (!iso) return '从未打开'
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return d.toLocaleDateString('zh-CN')
}
