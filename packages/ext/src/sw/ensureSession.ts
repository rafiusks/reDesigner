import type { TabHandshake, TabSession } from './messageRouter.js'
import { postExchange } from './rest.js'

const SESSION_REFRESH_LEAD_MS = 60_000

export interface EnsureSessionDeps {
  tabSessions: Map<number, TabSession>
  extId: string // chrome.runtime.id — passed so postExchange can emit the header
}

export async function ensureSession(
  tabId: number,
  hs: TabHandshake,
  deps: EnsureSessionDeps,
): Promise<string> {
  const cached = deps.tabSessions.get(tabId)
  if (cached && cached.exp - Date.now() > SESSION_REFRESH_LEAD_MS) {
    return cached.sessionToken
  }
  const res = await postExchange({
    httpUrl: hs.httpUrl,
    clientNonce: crypto.randomUUID(),
    bootstrapToken: hs.bootstrapToken,
    extId: deps.extId,
  })
  deps.tabSessions.set(tabId, { sessionToken: res.sessionToken, exp: res.exp })
  return res.sessionToken
}
