/**
 * Problem response helpers (RFC 9457 / application/problem+json).
 *
 * Moved from types.ts to consolidate all problem-body logic here.
 * sendProblem now sets:
 *   - Content-Type: application/problem+json; charset=utf-8 (RFC 9457 §3 explicit charset)
 *   - Vary: Origin, Access-Control-Request-Headers (always — problem bodies are CORS-reachable)
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { applyCorsHeaders } from './routes/cors.js'

export interface ProblemResponse {
  type: string
  title: string
  status: number
  code: string
  detail?: string
  instance: string
}

export function problem(
  status: number,
  code: string,
  detail: string | undefined,
  reqId: string,
): ProblemResponse {
  const base = {
    type: `https://redesigner.dev/errors/${code.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`,
    title: code,
    status,
    code,
    instance: `/req/${reqId}`,
  }
  if (detail !== undefined) {
    return { ...base, detail }
  }
  return base
}

export function sendProblem(
  res: ServerResponse,
  p: ProblemResponse,
  extraHeaders?: Record<string, string>,
  req?: IncomingMessage,
): void {
  res.statusCode = p.status
  res.setHeader('Content-Type', 'application/problem+json; charset=utf-8')
  // Vary must be set on all CORS-reachable responses so caches don't serve the
  // wrong response to different origins or different request-header sets.
  if (req !== undefined) {
    applyCorsHeaders(res, req)
  } else {
    res.setHeader('Vary', 'Origin, Access-Control-Request-Headers')
  }
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v)
  res.end(JSON.stringify(p))
}
