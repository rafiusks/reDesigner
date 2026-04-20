/**
 * Thin typed REST client for the reDesigner daemon.
 *
 * CLAUDE.md invariants:
 *  - AbortSignal.timeout(ms) for all timeouts (never new AbortController + setTimeout;
 *    undici#2198 EventTarget leak).
 *  - Never AbortSignal.any([...]) — composes the same leak class (node#57736).
 *  - URL construction via `new URL(path, httpUrl)` — never string concat.
 *  - credentials:'omit', cache:'no-store' per spec §3.
 *  - Zod schemas at module top-level.
 */

import {
  type ExchangeResponse,
  ExchangeResponseSchema,
  type SelectionPutBody,
  SelectionPutBodySchema,
  type SelectionPutResponse,
  SelectionPutResponseSchema,
} from '@redesigner/core/schemas'
import { z } from 'zod'

const DEFAULT_TIMEOUT_MS = 5_000

const HealthResponseSchema = z.object({ ok: z.literal(true) }).passthrough()
type HealthResponse = z.infer<typeof HealthResponseSchema>

export interface RestArgs {
  httpUrl: string
  timeoutMs?: number
}

/**
 * Problem+json error with apiErrorCode + HTTP status. Thrown by all REST helpers
 * for non-2xx responses, schema-invalid payloads, and aborted fetches.
 */
export class DaemonRestError extends Error {
  readonly name = 'DaemonRestError'
  constructor(
    public readonly status: number,
    public readonly apiErrorCode: string | null,
    public readonly detail: string,
    public readonly raw: unknown,
  ) {
    super(`${status} ${apiErrorCode ?? 'unknown'}: ${detail}`)
  }
}

function resolveUrl(path: string, httpUrl: string): string {
  return new URL(path, httpUrl).toString()
}

function makeJsonHeaders(bearer?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json; charset=utf-8',
  }
  if (bearer !== undefined) headers.Authorization = `Bearer ${bearer}`
  return headers
}

async function parseProblemBody(res: Response): Promise<{
  apiErrorCode: string | null
  detail: string
  raw: unknown
}> {
  let raw: unknown = null
  try {
    const text = await res.text()
    if (text.length > 0) raw = JSON.parse(text)
  } catch {
    // Non-JSON body; leave raw as null.
  }
  if (raw !== null && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    const apiErrorCode = typeof obj.apiErrorCode === 'string' ? obj.apiErrorCode : null
    const detail =
      typeof obj.detail === 'string'
        ? obj.detail
        : typeof obj.title === 'string'
          ? obj.title
          : `HTTP ${res.status}`
    return { apiErrorCode, detail, raw }
  }
  return { apiErrorCode: null, detail: `HTTP ${res.status}`, raw }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    return err.name === 'AbortError' || err.name === 'TimeoutError'
  }
  return false
}

async function doFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  // AbortSignal.timeout — CLAUDE.md: never new AbortController + setTimeout.
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    return await fetch(url, { ...init, signal })
  } catch (err) {
    if (isAbortError(err)) {
      throw new DaemonRestError(0, 'timeout', `request timed out after ${timeoutMs}ms`, err)
    }
    // Network-layer error — surface as 0/network.
    const detail = err instanceof Error ? err.message : String(err)
    throw new DaemonRestError(0, 'network-error', detail, err)
  }
}

async function requireOk(res: Response): Promise<void> {
  if (res.ok) return
  const { apiErrorCode, detail, raw } = await parseProblemBody(res)
  throw new DaemonRestError(res.status, apiErrorCode, detail, raw)
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch (err) {
    throw new DaemonRestError(
      res.status,
      'invalid-response',
      'response body was not valid JSON',
      err,
    )
  }
}

export async function postExchange(
  args: RestArgs & { clientNonce: string; bootstrapToken: string },
): Promise<ExchangeResponse> {
  const url = resolveUrl('/__redesigner/exchange', args.httpUrl)
  const res = await doFetch(
    url,
    {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      headers: makeJsonHeaders(),
      body: JSON.stringify({
        clientNonce: args.clientNonce,
        bootstrapToken: args.bootstrapToken,
      }),
    },
    args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  await requireOk(res)
  const body = await readJson(res)
  const parsed = ExchangeResponseSchema.safeParse(body)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => i.message).join('; ')
    throw new DaemonRestError(res.status, 'invalid-response', detail, body)
  }
  return parsed.data
}

export async function putSelection(
  args: RestArgs & { tabId: number; sessionToken: string; body: SelectionPutBody },
): Promise<SelectionPutResponse> {
  if (!Number.isInteger(args.tabId) || args.tabId < 0) {
    throw new DaemonRestError(0, 'invalid-params', 'tabId must be a non-negative integer', null)
  }
  const url = resolveUrl(`/tabs/${args.tabId}/selection`, args.httpUrl)
  // Pre-validate request body so callers surface schema errors at the REST
  // boundary rather than via a 400 round-trip.
  const bodyParsed = SelectionPutBodySchema.safeParse(args.body)
  if (!bodyParsed.success) {
    const detail = bodyParsed.error.issues.map((i) => i.message).join('; ')
    throw new DaemonRestError(0, 'invalid-params', detail, args.body)
  }
  const res = await doFetch(
    url,
    {
      method: 'PUT',
      credentials: 'omit',
      cache: 'no-store',
      headers: makeJsonHeaders(args.sessionToken),
      body: JSON.stringify(args.body),
    },
    args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  await requireOk(res)
  const body = await readJson(res)
  const parsed = SelectionPutResponseSchema.safeParse(body)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => i.message).join('; ')
    throw new DaemonRestError(res.status, 'invalid-response', detail, body)
  }
  return parsed.data
}

export async function getHealth(
  args: RestArgs & { sessionToken: string },
): Promise<HealthResponse> {
  const url = resolveUrl('/__redesigner/health', args.httpUrl)
  const res = await doFetch(
    url,
    {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      headers: makeJsonHeaders(args.sessionToken),
    },
    args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  await requireOk(res)
  const body = await readJson(res)
  const parsed = HealthResponseSchema.safeParse(body)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => i.message).join('; ')
    throw new DaemonRestError(res.status, 'invalid-response', detail, body)
  }
  return parsed.data
}
