import { fetchHandshake, parseHandshakeJson, readMetaHandshake } from './handshake.js'
import type { HandshakeResult } from './handshake.js'

// Module-level state so stopContentScript() can clean up.
let _observer: MutationObserver | null = null
let _beforeUnloadHandler: (() => void) | null = null
let _running = false

async function doRegister(fields: HandshakeResult): Promise<void> {
  const clientId = crypto.randomUUID()
  await chrome.runtime.sendMessage({
    type: 'register',
    wsUrl: fields.wsUrl,
    httpUrl: fields.httpUrl,
    bootstrapToken: fields.bootstrapToken,
    editor: fields.editor,
    clientId,
  })
}

function buildFromMeta(meta: Partial<HandshakeResult> | null): HandshakeResult | null {
  if (!meta) return null
  const { bootstrapToken, wsUrl, httpUrl, editor } = meta
  if (!bootstrapToken || !wsUrl || !httpUrl || !editor) return null
  return { bootstrapToken, wsUrl, httpUrl, editor }
}

async function performHandshake(): Promise<void> {
  const headMetaEl = document.head?.querySelector<HTMLMetaElement>('meta[name="redesigner-daemon"]')
  const bodyMetaEl = document.body?.querySelector<HTMLMetaElement>('meta[name="redesigner-daemon"]')

  if (bodyMetaEl && !headMetaEl) {
    // meta-in-body is a quirk; we still attempt registration best-effort.
    console.warn('[redesigner] meta element found in <body> — proceeding best-effort', {
      dormantReason: 'meta-in-body',
    })
  }

  // Prefer head meta; fall back to body meta for httpUrl extraction.
  const metaFields = headMetaEl
    ? readMetaHandshake(document)
    : bodyMetaEl
      ? parseHandshakeJson(bodyMetaEl.content)
      : null

  const httpUrl = metaFields?.httpUrl

  let fetched: HandshakeResult | null = null
  if (httpUrl) {
    fetched = await fetchHandshake(httpUrl)
  }

  const merged = fetched ?? buildFromMeta(metaFields)
  if (!merged) return

  await doRegister(merged)
}

// Tears down the observer and beforeunload listener. Safe to call multiple times.
export function stopContentScript(): void {
  _observer?.disconnect()
  _observer = null
  if (_beforeUnloadHandler) {
    window.removeEventListener('beforeunload', _beforeUnloadHandler)
    _beforeUnloadHandler = null
  }
  _running = false
}

export async function runContentScript(): Promise<void> {
  // Guard: only run in top-level frame.
  if (window.top !== window) return

  // Boot-once guard — tear down existing state before re-running.
  if (_running) {
    stopContentScript()
  }
  _running = true

  let lastMetaContent =
    document.head?.querySelector<HTMLMetaElement>('meta[name="redesigner-daemon"]')?.content ?? null

  await performHandshake()

  _observer = new MutationObserver(() => {
    const newContent =
      document.head?.querySelector<HTMLMetaElement>('meta[name="redesigner-daemon"]')?.content ??
      null

    if (newContent !== lastMetaContent) {
      lastMetaContent = newContent
      void performHandshake()
    }
  })

  _observer.observe(document.head, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['content'],
  })

  _beforeUnloadHandler = () => {
    stopContentScript()
  }
  window.addEventListener('beforeunload', _beforeUnloadHandler)
}

// Run when loaded as a real content script (not in test).
if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
  void runContentScript()
}
