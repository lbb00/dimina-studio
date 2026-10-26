import { forwardToService } from './bridge-router-transport.js'
import type { AppSession } from './bridge-router-types.js'
import type { NavActionPayload } from '../../shared/bridge-channels.js'

export function extractCallbacks(params: Record<string, unknown>): NavActionPayload['callbacks'] {
  return { success: params.success, fail: params.fail, complete: params.complete }
}

export function normalizeParams(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : { value: params }
}

export function sendCallback(ap: AppSession, id: unknown, args: unknown): void {
  if (id === undefined || id === null) return
  forwardToService(ap, { type: 'triggerCallback', target: 'service', body: { id, args } })
}
