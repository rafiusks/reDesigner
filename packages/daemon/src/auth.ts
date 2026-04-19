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
