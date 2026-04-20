/**
 * Content script entry point — document_end (spec §4.1 steps 2-4).
 *
 * Responsibilities:
 *  1. Read <meta name="redesigner-daemon"> for baseline fields.
 *  2. Detect meta-in-body quirk and log dormantReason.
 *  3. Fetch /__redesigner/handshake.json (credentials:'omit').
 *  4. Generate clientId = crypto.randomUUID().
 *  5. Send {type:'register', wsUrl, httpUrl, bootstrapToken, editor, clientId} to SW.
 *     SW enriches with tabId/windowId from sender metadata.
 *  6. Attach MutationObserver on document.head; re-registers on meta changes.
 *  7. Disconnect observer on beforeunload.
 *
 * Guard: no-op in iframes (window.top !== window).
 */

import { EditorSchema } from '../shared/editors.js'
import { fetchHandshake, readMetaHandshake } from './handshake.js'
import type { HandshakeResult } from './handshake.js'

/**
 * Builds and sends the register message to the service worker.
 * CS never sends tabId/windowId — SW injects those from sender.tab.id/windowId.
 */
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

/**
 * Parses redesigner-daemon meta content string into partial HandshakeResult.
 * Synchronous — used for body-located meta that querySelector won't find from head.
 */
function parseMetaContent(content: string): Partial<HandshakeResult> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  const result: Partial<HandshakeResult> = {}
  if (typeof obj.wsUrl === 'string') result.wsUrl = obj.wsUrl
  if (typeof obj.httpUrl === 'string') result.httpUrl = obj.httpUrl
  if (typeof obj.bootstrapToken === 'string') result.bootstrapToken = obj.bootstrapToken
  const editorParse = EditorSchema.safeParse(obj.editor)
  if (editorParse.success) result.editor = editorParse.data
  return result
}

/**
 * Builds a HandshakeResult from partial meta fields, returning null if any
 * required field is missing.
 */
function buildFromMeta(meta: Partial<HandshakeResult> | null): HandshakeResult | null {
  if (!meta) return null
  const { bootstrapToken, wsUrl, httpUrl, editor } = meta
  if (!bootstrapToken || !wsUrl || !httpUrl || !editor) return null
  return { bootstrapToken, wsUrl, httpUrl, editor }
}

/**
 * Performs the full handshake flow:
 *  - Reads meta (head + body detection).
 *  - Fetches the handshake endpoint.
 *  - Merges results (fetch preferred; meta as fallback).
 *  - Sends register if enough fields are present.
 */
async function performHandshake(): Promise<void> {
  // Read meta from document (querySelector searches <head> first by default
  // through readMetaHandshake, which uses document.querySelector).
  const headMetaEl = document.head?.querySelector<HTMLMetaElement>('meta[name="redesigner-daemon"]')
  const bodyMetaEl = document.body?.querySelector<HTMLMetaElement>('meta[name="redesigner-daemon"]')

  // Detect body-only meta quirk.
  if (bodyMetaEl && !headMetaEl) {
    console.warn('[redesigner] meta in <body> — silent drop case', {
      dormantReason: 'meta-in-body',
    })
  }

  // Prefer head meta; fall back to body meta for httpUrl extraction.
  const metaFields = headMetaEl
    ? readMetaHandshake(document)
    : bodyMetaEl
      ? parseMetaContent(bodyMetaEl.content)
      : null

  const httpUrl = metaFields?.httpUrl

  let fetched: HandshakeResult | null = null
  if (httpUrl) {
    fetched = await fetchHandshake(httpUrl)
  }

  // Merge: fetched result is preferred; fall through to meta as baseline.
  const merged = fetched ?? buildFromMeta(metaFields)
  if (!merged) return

  await doRegister(merged)
}

/**
 * Exported for test injection. Tests call this instead of relying on
 * module-load side-effects so they can control the execution context.
 */
export async function runContentScript(): Promise<void> {
  // Guard: only run in top-level frame.
  if (window.top !== window) return

  let lastMetaContent =
    document.head?.querySelector<HTMLMetaElement>('meta[name="redesigner-daemon"]')?.content ?? null

  await performHandshake()

  // MutationObserver: re-register when meta content changes or is injected late.
  const observer = new MutationObserver(() => {
    const newContent =
      document.head?.querySelector<HTMLMetaElement>('meta[name="redesigner-daemon"]')?.content ??
      null

    if (newContent !== lastMetaContent) {
      lastMetaContent = newContent
      void performHandshake()
    }
  })

  observer.observe(document.head, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['content'],
  })

  window.addEventListener('beforeunload', () => {
    observer.disconnect()
  })
}

// Auto-run when loaded as a real content script (not in test).
// Tests import and call runContentScript() explicitly.
if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
  void runContentScript()
}
