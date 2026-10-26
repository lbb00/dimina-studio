export interface ApiFailureVerdict {
  ok: false
  errMsg: string
  result?: unknown
}

/** Converts the simulator's callback payload into the bridge failure shape. */
export function callbackFailureVerdict(name: string, result: unknown): ApiFailureVerdict {
  const errMsg =
    result && typeof result === 'object' && 'errMsg' in (result as Record<string, unknown>)
      ? String((result as { errMsg?: unknown }).errMsg)
      : `${name}:fail`
  return { ok: false, errMsg, result }
}

/** Gives thrown and rejected values the same bridge error message. */
export function thrownFailureVerdict(name: string, error: unknown): ApiFailureVerdict {
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, errMsg: `${name}:fail ${message}` }
}
