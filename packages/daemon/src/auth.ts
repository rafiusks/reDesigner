import crypto from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export function compareToken(provided: unknown, expected: Buffer): boolean {
  let providedBuf: Buffer
  try {
    providedBuf = typeof provided === 'string' ? Buffer.from(provided, 'utf8') : Buffer.alloc(0)
  } catch {
    providedBuf = Buffer.alloc(0)
  }
  if (providedBuf.length !== expected.length) {
    crypto.timingSafeEqual(expected, expected)
    return false
  }
  return crypto.timingSafeEqual(providedBuf, expected)
}

export function extractBearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (typeof header !== 'string') return undefined
  if (!header.startsWith('Bearer ')) return undefined
  return header.slice('Bearer '.length)
}

export const UNAUTHORIZED_HEADERS = { 'WWW-Authenticate': 'Bearer realm="redesigner"' } as const

/**
 * k8s-shape WebSocket subprotocol bearer auth.
 *
 * Browsers cannot set arbitrary request headers on the WS upgrade (no
 * Authorization), so the bearer is smuggled inside Sec-WebSocket-Protocol via a
 * well-known fixed prefix. The prefix matches the k8s convention:
 *   base64url.bearer.authorization.<domain>.<token>
 * Here the domain is `redesigner.dev`. The suffix is the raw bearer string.
 *
 * Parsing rules:
 *  - The header is comma-separated HTTP tokens. We trim each entry.
 *  - We do NOT split on `.` — the prefix itself contains dots.
 *  - Extraction is strict fixed-prefix + suffix.
 */
export const SUBPROTO_BEARER_PREFIX = 'base64url.bearer.authorization.redesigner.dev.'
export const MAX_SUBPROTOCOL_ENTRIES = 8

const VERSIONED_SUBPROTO_RE = /^redesigner-v\d+$/

export interface SubprotocolParseResult {
  /** Raw entries (trimmed, in header order). Empty if header absent. */
  entries: string[]
  /** Subset of entries matching /^redesigner-v\d+$/. */
  versionedOffers: string[]
  /** Bearer string from the fixed-prefix entry, or null if no such entry. */
  bearer: string | null
  /** True if entry count exceeds MAX_SUBPROTOCOL_ENTRIES. */
  tooMany: boolean
}

export function extractSubprotocolToken(req: IncomingMessage): SubprotocolParseResult {
  const raw = req.headers['sec-websocket-protocol']
  const headerVal = Array.isArray(raw) ? raw.join(',') : typeof raw === 'string' ? raw : ''
  if (headerVal.length === 0) {
    return { entries: [], versionedOffers: [], bearer: null, tooMany: false }
  }
  const entries = headerVal
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
  const tooMany = entries.length > MAX_SUBPROTOCOL_ENTRIES
  const versionedOffers: string[] = []
  let bearer: string | null = null
  for (const entry of entries) {
    if (VERSIONED_SUBPROTO_RE.test(entry)) {
      versionedOffers.push(entry)
    } else if (entry.startsWith(SUBPROTO_BEARER_PREFIX)) {
      // First bearer wins. Duplicates are ignored.
      if (bearer === null) {
        const suffix = entry.slice(SUBPROTO_BEARER_PREFIX.length)
        // Empty suffix → treat as no bearer (malformed entry).
        bearer = suffix.length > 0 ? suffix : null
      }
    }
  }
  return { entries, versionedOffers, bearer, tooMany }
}
