import type { RuntimeContext } from '../runtime-context.js'
import type { AppSession, PageSession, RouterState } from './bridge-router-types.js'
import { clearLaunchTimer } from './bridge-router-state.js'

export const LAUNCH_TIMEOUT_MS = 20_000

export function startLaunchTimer(state: RouterState, ctx: RuntimeContext, ap: AppSession): void {
  ap.launchTimer = setTimeout(() => {
    ap.launchTimer = null
    if (ap.running || state.appSessions.get(ap.appSessionId) !== ap) return
    const reason = `Service host did not report readiness within ${LAUNCH_TIMEOUT_MS}ms`
    ctx.diagnostics?.report({ severity: 'error', code: 'launch-timeout', message: reason, appSessionId: ap.appSessionId })
    pushRuntimeStatus(ctx, ap, { phase: 'launch-failed', code: 'timeout', reason })
  }, LAUNCH_TIMEOUT_MS)
}

export function markSessionRunning(ctx: RuntimeContext, ap: AppSession, page: PageSession): void {
  if (!page.isRoot || ap.running) return
  ap.running = true
  clearLaunchTimer(ap)
  pushRuntimeStatus(ctx, ap, { phase: 'running' })
}

export function pushRuntimeStatus(
  ctx: RuntimeContext,
  session: Pick<AppSession, 'appId' | 'pageFallback'>,
  status: { phase: 'launching' | 'running' | 'launch-failed' | 'crashed'; code?: string; reason?: string },
): void {
  ctx.events.emit('session-status', { appId: session.appId, ...status, ...(session.pageFallback ? { pageFallback: session.pageFallback } : {}) })
}
