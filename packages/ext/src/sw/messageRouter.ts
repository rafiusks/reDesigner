/**
 * Routes chrome.runtime.onMessage frames. Lives in its own module because
 * sw/index.ts has a static regex guard (test/integration/hydrate.test.ts)
 * forbidding `await` or `async function` before the final top-level
 * addListener registration — so the async handler body lives here.
 */

import type { PanelPort } from './panelPort.js'
import { postExchange } from './rest.js'

export interface TabHandshake {
  wsUrl: string
  httpUrl: string
  bootstrapToken: string
  editor: string
}

export interface TabSession {
  sessionToken: string
  exp: number
}

export interface MessageRouterDeps {
  panelPort: PanelPort
  tabHandshakes: Map<number, TabHandshake>
  tabSessions: Map<number, TabSession>
}

const SESSION_REFRESH_LEAD_MS = 60_000

async function ensureSession(
  tabId: number,
  hs: TabHandshake,
  deps: MessageRouterDeps,
): Promise<string> {
  const cached = deps.tabSessions.get(tabId)
  if (cached && cached.exp - Date.now() > SESSION_REFRESH_LEAD_MS) {
    return cached.sessionToken
  }
  const res = await postExchange({
    httpUrl: hs.httpUrl,
    clientNonce: crypto.randomUUID(),
    bootstrapToken: hs.bootstrapToken,
  })
  deps.tabSessions.set(tabId, { sessionToken: res.sessionToken, exp: res.exp })
  return res.sessionToken
}

type SendResponse = (response?: unknown) => void

export async function routeMessage(
  msg: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: SendResponse,
  deps: MessageRouterDeps,
): Promise<void> {
  if (typeof msg !== 'object' || msg === null) {
    sendResponse({ ok: true })
    return
  }
  const type = (msg as { type?: unknown }).type
  const tabId = sender.tab?.id
  const windowId = sender.tab?.windowId

  if (type === 'register') {
    const tabUrl = sender.tab?.url
    const m = msg as Partial<TabHandshake> & { type: 'register' }
    console.log('[redesigner:sw] register from tab', {
      tabId,
      windowId,
      tabUrl,
      frameId: sender.frameId,
    })
    if (typeof tabId === 'number' && typeof windowId === 'number' && tabUrl) {
      if (
        typeof m.wsUrl === 'string' &&
        typeof m.httpUrl === 'string' &&
        typeof m.bootstrapToken === 'string' &&
        typeof m.editor === 'string'
      ) {
        deps.tabHandshakes.set(tabId, {
          wsUrl: m.wsUrl,
          httpUrl: m.httpUrl,
          bootstrapToken: m.bootstrapToken,
          editor: m.editor,
        })
      }
      let origin: string | null = null
      try {
        origin = new URL(tabUrl).origin
      } catch {
        /* non-http tab; leave origin null */
      }
      deps.panelPort.push(windowId, tabId, { status: 'connected', serverUrl: origin })
      console.log('[redesigner:sw] pushed serverUrl', origin, 'to panel', { windowId, tabId })
    } else {
      console.warn('[redesigner:sw] register: missing tab metadata on sender')
    }
    sendResponse({ ok: true })
    return
  }

  if (type === 'get-manifest') {
    if (typeof tabId !== 'number') {
      sendResponse({ error: 'no tab on sender' })
      return
    }
    const hs = deps.tabHandshakes.get(tabId)
    if (!hs) {
      sendResponse({ error: 'no handshake for tab — page not registered yet' })
      return
    }
    try {
      const sessionToken = await ensureSession(tabId, hs, deps)
      const res = await fetch(new URL('/manifest', hs.httpUrl).toString(), {
        headers: { Authorization: `Bearer ${sessionToken}` },
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) {
        sendResponse({ error: `HTTP ${res.status} from daemon /manifest` })
        return
      }
      const manifest = await res.json()
      sendResponse({ manifest })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendResponse({ error: `get-manifest: ${message}` })
    }
    return
  }

  if (type === 'selection') {
    const handle = (msg as { handle?: unknown }).handle
    if (typeof tabId === 'number' && typeof windowId === 'number') {
      deps.panelPort.push(windowId, tabId, { selection: handle ?? null })
      console.log('[redesigner:sw] selection pushed', { tabId, windowId })
    }
    sendResponse({ ok: true })
    return
  }

  sendResponse({ ok: true })
}
