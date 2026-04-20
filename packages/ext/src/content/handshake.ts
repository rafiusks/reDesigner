import { type Editor, EditorSchema } from '../shared/editors.js'

export interface HandshakeResult {
  bootstrapToken: string
  wsUrl: string
  httpUrl: string
  editor: Editor
}

// Shared JSON parse helper — used by both readMetaHandshake and content/index.ts.
export function parseHandshakeJson(json: string): Partial<HandshakeResult> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
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

// Reads <meta name="redesigner-daemon"> and returns a partial HandshakeResult.
// Returns null if the tag is absent or content is unparseable JSON.
export function readMetaHandshake(doc: Document = document): Partial<HandshakeResult> | null {
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="redesigner-daemon"]')
  if (!meta) return null
  return parseHandshakeJson(meta.content)
}

// Fetches /__redesigner/handshake.json from the given httpUrl base.
// Uses credentials:'omit' and cache:'no-store' per spec §4.1 step 2.
// Token priority: X-Redesigner-Bootstrap header (preferred) → body.bootstrapToken (fallback).
// Returns null on network error, non-2xx, or schema-invalid response.
// Never throws — CS must not crash the host page.
export async function fetchHandshake(httpUrl: string): Promise<HandshakeResult | null> {
  const url = new URL('/__redesigner/handshake.json', httpUrl).toString()

  let response: Response
  try {
    response = await fetch(url, { credentials: 'omit', cache: 'no-store' })
  } catch (err) {
    console.warn('[redesigner] fetchHandshake: network error', err)
    return null
  }

  if (!response.ok) {
    console.warn(`[redesigner] fetchHandshake: HTTP ${response.status}`)
    return null
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (err) {
    console.warn('[redesigner] fetchHandshake: invalid JSON body', err)
    return null
  }

  if (typeof body !== 'object' || body === null) {
    console.warn('[redesigner] fetchHandshake: body is not an object')
    return null
  }

  const obj = body as Record<string, unknown>

  // bootstrapToken: header preferred, body as fallback.
  const headerToken = response.headers.get('X-Redesigner-Bootstrap')
  const bodyToken = typeof obj.bootstrapToken === 'string' ? obj.bootstrapToken : ''
  const bootstrapToken = headerToken && headerToken.length > 0 ? headerToken : bodyToken

  if (!bootstrapToken) {
    console.warn('[redesigner] fetchHandshake: bootstrapToken absent')
    return null
  }

  const wsUrl = typeof obj.wsUrl === 'string' ? obj.wsUrl : ''
  const httpUrlVal = typeof obj.httpUrl === 'string' ? obj.httpUrl : ''

  try {
    new URL(wsUrl)
    new URL(httpUrlVal)
  } catch {
    console.warn('[redesigner] fetchHandshake: invalid wsUrl or httpUrl in body')
    return null
  }

  const editorParse = EditorSchema.safeParse(obj.editor)
  if (!editorParse.success) {
    console.warn('[redesigner] fetchHandshake: invalid editor in body', obj.editor)
    return null
  }

  return {
    bootstrapToken,
    wsUrl,
    httpUrl: httpUrlVal,
    editor: editorParse.data,
  }
}
