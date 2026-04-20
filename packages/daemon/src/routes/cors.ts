/**
 * CORS header helpers for the daemon HTTP server.
 *
 * Design constraints (per spec Task 11):
 *   - Vary: Origin, Access-Control-Request-Headers on every CORS-reachable response
 *     (2xx, 3xx, 4xx, 5xx, preflights). Browsers cache preflights keyed on the
 *     request-header set; Vary must list it.
 *   - Access-Control-Allow-Credentials MUST NOT be set. Daemon uses no cookies;
 *     any credentialed request carrying Cookie is suspicious and rejected upstream.
 *   - Allowed CORS origins: chrome-extension:// (any 32-letter ID) +
 *     localhost dev origins. Mirrors the origin policy in exchange.ts.
 *   - Cache-Control: no-store, private + Pragma: no-cache on sensitive routes.
 *     NOTE: handshake.json cache headers are the Vite plugin's responsibility
 *     (Task 13). Only daemon-served routes are handled here.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CorsError } from '@redesigner/core/schemas'

// HTTP allowlist narrower than WS allowlist (events.ts ORIGIN_ALLOW) — Firefox/VS Code extensions are WS-only in v0.
// Allowed CORS origin patterns.
// chrome-extension://<32 a-p letters> — extension
// http://localhost:* and http://127.0.0.1:* — dev tooling
const ALLOWED_ORIGIN_RE =
  /^(chrome-extension:\/\/[a-p]{32}|https?:\/\/localhost(:\d+)?|https?:\/\/127\.0\.0\.1(:\d+)?)$/

/**
 * Apply CORS response headers to an outgoing response.
 *
 * Always sets Vary. If the request Origin is in the allowlist, sets
 * Access-Control-Allow-Origin to that origin (not '*' — the token is
 * sensitive so we never use wildcard).
 *
 * NEVER sets Access-Control-Allow-Credentials.
 */
export function applyCorsHeaders(res: ServerResponse, req: IncomingMessage): void {
  res.setHeader('Vary', 'Origin, Access-Control-Request-Headers')

  const originHeader = req.headers.origin
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader
  if (typeof origin === 'string' && ALLOWED_ORIGIN_RE.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  // Access-Control-Allow-Credentials is intentionally NEVER set (see module doc).
}

// 403 bodies use application/json (not application/problem+json) so clients can
// parse them with CorsErrorSchema.safeParse — the discriminated union replaces
// RFC 7807 problem+json on these specific rejection paths.

/** Reject with 403 + CorsError when Origin header is absent. */
export function rejectMissingOrigin(res: ServerResponse): void {
  const body: CorsError = { error: 'cors', reason: 'missing-origin' }
  res.setHeader('Vary', 'Origin, Access-Control-Request-Headers')
  res.statusCode = 403
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

/** Reject with 403 + CorsError when Origin is present but outside the allowlist. */
export function rejectMalformedOrigin(res: ServerResponse, req: IncomingMessage): void {
  const body: CorsError = { error: 'cors', reason: 'malformed-origin' }
  res.setHeader('Vary', 'Origin, Access-Control-Request-Headers')
  applyCorsHeaders(res, req)
  res.statusCode = 403
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

/**
 * Handle an OPTIONS preflight request.
 *
 * Returns 204 on success (allowed origin + known path).
 * Returns 403 + CorsError body on disallowed Origin.
 *
 * The caller is responsible for checking if the pathname is known;
 * this function handles the CORS protocol layer only.
 *
 * @param allowedMethods Comma-free list, e.g. 'GET' or 'PUT' or 'POST'.
 */
export function handlePreflight(
  req: IncomingMessage,
  res: ServerResponse,
  allowedMethods: string,
): void {
  res.setHeader('Vary', 'Origin, Access-Control-Request-Headers')

  const originHeader = req.headers.origin
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader

  if (typeof origin !== 'string') {
    rejectMissingOrigin(res)
    return
  }
  if (!ALLOWED_ORIGIN_RE.test(origin)) {
    rejectMalformedOrigin(res, req)
    return
  }

  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', allowedMethods)

  // Echo the requested headers back so the browser trusts them.
  const requestedHeaders = req.headers['access-control-request-headers']
  if (typeof requestedHeaders === 'string' && requestedHeaders.length > 0) {
    res.setHeader('Access-Control-Allow-Headers', requestedHeaders)
  } else if (Array.isArray(requestedHeaders) && requestedHeaders.length > 0) {
    res.setHeader('Access-Control-Allow-Headers', requestedHeaders.join(', '))
  }

  // 5 minutes preflight cache (safe — the allow-list is static).
  res.setHeader('Access-Control-Max-Age', '300')

  res.statusCode = 204
  res.end()
}

/**
 * Set Cache-Control: no-store, private + Pragma: no-cache.
 * Use on responses that must not be cached by intermediaries or the browser:
 *   - /__redesigner/exchange (session token minting)
 *   - /__redesigner/revalidate (session rotation)
 *   - PUT /tabs/{tabId}/selection (current selection state)
 *   - GET /selection (current selection snapshot)
 * NOTE: /__redesigner/handshake.json is served by the Vite plugin (Task 13);
 *       its cache headers are that plugin's responsibility, not the daemon's.
 */
export function noStorePrivate(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('Pragma', 'no-cache')
}

/**
 * Reject the request if it carries a Cookie header.
 *
 * The daemon does not use cookies. A credentialed request with Cookie is
 * suspicious — it could indicate CSRF or session-fixation. Reject early
 * with 400 invalid-params before any route logic runs.
 *
 * @returns true if the request was rejected (caller should return immediately).
 *          false if clean (no Cookie header present).
 */
export function rejectCookieIfPresent(
  req: IncomingMessage,
  res: ServerResponse,
  reqId: string,
): boolean {
  const cookie = req.headers.cookie
  if (cookie === undefined) return false

  applyCorsHeaders(res, req)

  const p = {
    type: 'https://redesigner.dev/errors/invalid-params',
    title: 'InvalidParams',
    status: 400,
    code: 'InvalidParams',
    instance: `/req/${reqId}`,
    detail: 'Cookie header is not accepted on this route',
    apiErrorCode: 'invalid-params',
  }
  res.statusCode = 400
  res.setHeader('Content-Type', 'application/problem+json; charset=utf-8')
  res.end(JSON.stringify(p))
  return true
}
