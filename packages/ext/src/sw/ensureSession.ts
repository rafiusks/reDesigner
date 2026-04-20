import type { TabHandshake, TabSession } from './messageRouter.js'
import { postExchange } from './rest.js'

const SESSION_REFRESH_LEAD_MS = 60_000

export interface EnsureSessionDeps {
  tabSessions: Map<number, TabSession>
  extId: string
}

export interface EnsureSessionResult {
  sessionToken: string
  // true when this call triggered a /exchange round-trip, false when the
  // cached session was still within SESSION_REFRESH_LEAD_MS of expiry.
  // Owned here so callers can't drift from the freshness predicate.
  cold: boolean
}

export async function ensureSession(
  tabId: number,
  hs: TabHandshake,
  deps: EnsureSessionDeps,
): Promise<EnsureSessionResult> {
  const cached = deps.tabSessions.get(tabId)
  if (cached && cached.exp - Date.now() > SESSION_REFRESH_LEAD_MS) {
    return { sessionToken: cached.sessionToken, cold: false }
  }
  const res = await postExchange({
    httpUrl: hs.httpUrl,
    clientNonce: crypto.randomUUID(),
    bootstrapToken: hs.bootstrapToken,
    extId: deps.extId,
  })
  deps.tabSessions.set(tabId, { sessionToken: res.sessionToken, exp: res.exp })
  return { sessionToken: res.sessionToken, cold: true }
}
