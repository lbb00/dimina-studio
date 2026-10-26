/**
 * Process-wide multiplexing for the `dmb-resource://` protocol handler.
 *
 * The scheme is served from registrars that are shared by the whole process —
 * the default `protocol`, the shared miniapp partition, and every per-project
 * partition session — but the handler itself has to resolve the requested
 * bridgeId against ONE router's session ledger. With a router per workbench
 * window, installing per router would let the newest window's handler answer
 * every window's requests (the older window's bridgeIds resolve to nothing),
 * and the first window to close would unhandle the scheme for all of them.
 *
 * So the real handler is installed once and dispatches per request: the entry
 * whose router can resolve the request's bridgeId serves it, carrying its own
 * `sdkRoot` and session ledger. Registrars are torn down only when the last
 * entry is gone.
 */

import { protocol, session as electronSession } from 'electron'
import type { Session } from 'electron'
import {
  registerMiniappSessionConfigurator,
  SHARED_MINIAPP_PARTITION,
} from '../services/views/miniapp-partition.js'

const SCHEME = 'dmb-resource'

export interface DmbResourceMuxEntry {
  /** Whether this router owns the session named by the request URL's bridgeId. */
  claims: (requestUrl: string, requestPartition: string) => boolean
  handle: (request: GlobalRequest, requestPartition: string) => Promise<Response>
}

const entries: DmbResourceMuxEntry[] = []
let uninstall: (() => void) | null = null

function install(): () => void {
  const handlerFor = (requestPartition: string) => (request: GlobalRequest): Promise<Response> => {
    // The Session that registered this handler is the authorization provenance.
    // Do not fall back to another router: an unclaimed bridge must stay absent.
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!
      if (entry.claims(request.url, requestPartition)) return entry.handle(request, requestPartition)
    }
    return Promise.resolve(new Response('Bridge session not found', { status: 404 }))
  }

  const sharedSession = electronSession.fromPartition(SHARED_MINIAPP_PARTITION)
  try { protocol.unhandle(SCHEME) } catch {}
  try { sharedSession.protocol.unhandle(SCHEME) } catch {}
  protocol.handle(SCHEME, handlerFor(''))
  sharedSession.protocol.handle(SCHEME, handlerFor(SHARED_MINIAPP_PARTITION))

  // Per-project partition sessions need the SAME handler so each project's
  // render/service can load `dmb-resource://…`. One configurator covers every
  // partition (current + future) for every router.
  const perProjectSessions = new Set<Session>()
  const unregisterConfigurator = registerMiniappSessionConfigurator((sess, partition) => {
    if (perProjectSessions.has(sess)) return
    perProjectSessions.add(sess)
    try { sess.protocol.unhandle(SCHEME) } catch {}
    sess.protocol.handle(SCHEME, handlerFor(partition))
  })

  return () => {
    unregisterConfigurator()
    try { protocol.unhandle(SCHEME) } catch {}
    try { sharedSession.protocol.unhandle(SCHEME) } catch {}
    for (const sess of perProjectSessions) {
      try { sess.protocol.unhandle(SCHEME) } catch {}
    }
    perProjectSessions.clear()
  }
}

/**
 * Register one router on the `dmb-resource://` scheme. Returns the disposer for
 * THIS registration; the scheme itself is unhandled only when the last one goes.
 */
export function addMuxedDmbResourceHandler(entry: DmbResourceMuxEntry): () => void {
  entries.push(entry)
  uninstall ??= install()
  return () => {
    const at = entries.indexOf(entry)
    if (at !== -1) entries.splice(at, 1)
    if (entries.length === 0 && uninstall) {
      const dispose = uninstall
      uninstall = null
      dispose()
    }
  }
}
