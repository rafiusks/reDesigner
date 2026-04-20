/**
 * POST /__redesigner/exchange — bootstrap-to-session handoff.
 *
 * Mints a session token from a fresh (clientNonce, serverNonce, iat) tuple
 * keyed on the daemon's long-lived rootToken. The token shape:
 *
 *   sessionToken = HMAC-SHA256(
 *     rootToken,
 *     Buffer.concat([clientNonceBytes, serverNonceBytes, iatBE8])
 *   ).toString('base64url').replace(/=+$/, '')
 *
 *   where iatBE8 is an 8-byte big-endian UInt64 of the issue-at time in
 *   integer seconds since epoch.
 *
 * Gates (spec 3.2):
 *   - Sec-Fetch-Site in {none, cross-site}
 *   - Origin === chrome-extension://<32 lowercase letters>
 *   - Per-(Origin, peerAddr) failed-exchange token bucket (burst 5, 1/s).
 *     Only FAILED exchanges count against this bucket; successes reset it.
 *     Per-clientNonce-prefix buckets would be trivially evaded.
 *   - bootstrapToken must match via compareToken (constant-time).
 *   - clientNonce is one-shot per bootstrap epoch; replay returns 401.
 *
 * TOFU (spec 3.2):
 *   - First successful exchange writes the ext-ID to
 *     $runtimeDir/<projectHash>/trusted-ext-id.
 *   - Subsequent exchanges from a different chrome-extension:// origin are
 *     rejected with 403 + apiErrorCode: 'unknown-extension'.
 *   - Auto-reset window: if pin exists but we are within 10s of daemon boot
 *     AND <=1 distinct origin has been seen so far, the pin is replaced.
 *     Papers over unpacked-dev-reload ext-ID churn.
 *   - CLI flags --extension-id <id> and --trust-any-extension override.
 *
 * Session rotation:
 *   - A successful exchange from an already-pinned ext-ID invalidates the
 *     prior session. There is at most one active session per ext-ID.
 *
 * NOTE: Host allowlist + auth-bearer are enforced upstream in server.ts.
 * This handler re-validates Origin because Origin is specific to
 * /exchange's threat model.
 */

import crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ExchangeRequestSchema } from '@redesigner/core/schemas'
import { compareToken } from '../auth.js'
import { resolveTrustedExtIdPath } from '../handoff.js'
import type { Logger } from '../logger.js'
import { createTokenBucket } from '../rateLimit.js'
import { clearTrustedExtId, readTrustedExtId, writeTrustedExtId } from '../tofu.js'
import { problem, readJsonBody, sendJson, sendProblem } from '../types.js'
import { applyCorsHeaders, handlePreflight, noStorePrivate, rejectCookieIfPresent } from './cors.js'

// All Zod schemas at module top-level - CLAUDE.md: in-handler z.object() is a v4 regression cliff.
const BodySchema = ExchangeRequestSchema

// chrome-extension IDs are exactly 32 characters drawn from a-p (base32 remapped hex).
const EXT_ID_REGEX = /^[a-p]{32}$/
// Exported so server.ts + ws/events.ts can parse the extId out of Origin for
// the session-token auth fallback. Single source of truth for what the
// /exchange handler considers a valid Origin.
export const CHROME_EXT_ORIGIN_REGEX = /^chrome-extension:\/\/([a-p]{32})$/
const ORIGIN_REGEX = CHROME_EXT_ORIGIN_REGEX

// Per-(Origin, peerAddr) failed-exchange bucket config.
// burst 5, rate 1/s: honest clients retry at human scale;
// attackers enumerating clientNonces hit the cap in <5s.
const FAILED_EXCHANGE_RATE_PER_SEC = 1
const FAILED_EXCHANGE_BURST = 5

// LRU cap for the (origin, peerAddr) -> bucket map.
const FAILED_BUCKET_CAP = 256

// Session TTL per spec: <= 300 s absolute.
const SESSION_TTL_SEC = 300

// TOFU unpacked-dev-reload auto-reset window (spec 3.2).
const AUTO_RESET_WINDOW_MS = 10_000

export interface CreateExchangeRouteOptions {
  rootToken: Buffer
  projectRoot: string
  logger: Logger
  trustAnyExtension?: boolean
  pinnedExtensionId?: string
  bootstrapToken?: Buffer
  now?: () => number
  boot?: { at: number }
}

export interface ExchangeRouteHandle {
  handler: (req: IncomingMessage, res: ServerResponse, reqId: string) => Promise<void>
  isSessionActive: (extId: string, sessionToken: string) => boolean
  getTrustedExtId: () => string | null
  /**
   * Rotate the active session for an ext-ID.
   * Called by /revalidate after minting a new session token to keep the shared
   * activeSessions map consistent. Mirrors what the exchange handler does
   * internally on a successful exchange.
   */
  rotateSession: (extId: string, newSessionToken: string) => void
  /**
   * Check if a clientNonce has already been consumed and, if not, consume it.
   * Returns true if the nonce was fresh (and is now marked used), false if
   * it was a replay. Shared between /exchange and /revalidate so nonces
   * cannot be replayed across routes.
   */
  consumeNonce: (clientNonce: string) => boolean
  /**
   * Expose the current bootstrapEpochId so /revalidate can namespace its
   * nonce check under the same epoch.
   */
  getBootstrapEpochId: () => string
}

function forbidUnknownExtension(
  res: ServerResponse,
  detail: string,
  reqId: string,
  req: IncomingMessage,
): void {
  const p = problem(403, 'Forbidden', detail, reqId)
  const body = { ...p, apiErrorCode: 'unknown-extension' }
  res.statusCode = 403
  res.setHeader('Content-Type', 'application/problem+json; charset=utf-8')
  applyCorsHeaders(res, req)
  res.end(JSON.stringify(body))
}

/**
 * Factory that returns an /exchange handler + in-memory state hooks.
 * Session state is not persisted to disk.
 */
export function createExchangeRoute(opts: CreateExchangeRouteOptions): ExchangeRouteHandle {
  const rootToken = opts.rootToken
  const projectRoot = opts.projectRoot
  const logger = opts.logger
  const trustAnyExtension = opts.trustAnyExtension === true
  const pinnedExtensionId = opts.pinnedExtensionId ?? null
  const bootstrapToken = opts.bootstrapToken ?? Buffer.from(crypto.randomBytes(32))
  const now = opts.now ?? (() => Date.now())
  const boot = opts.boot ?? { at: now() }

  // Bootstrap-epoch id changes each time bootstrapToken rotates. Used to
  // namespace the consumed-nonce set so a rotation flushes replays implicitly.
  // Bootstrap rotation wiring is not in this task; the namespace keeps the
  // extension point clean.
  const bootstrapEpochId = crypto
    .createHash('sha256')
    .update(bootstrapToken)
    .digest('hex')
    .slice(0, 16)

  // One-shot clientNonce tracker. Key: `<epochId>:<clientNonce>`.
  const consumedNonces = new Set<string>()

  // Active session per ext-ID. New exchange from same ext-ID invalidates prior.
  const activeSessions = new Map<string, Buffer>()

  // Per-(Origin, peerAddr) failed-exchange rate-limit buckets (LRU map).
  const failedBuckets = new Map<string, ReturnType<typeof createTokenBucket>>()

  // Set of distinct chrome-extension origins observed during the auto-reset window.
  const bootWindowOrigins = new Set<string>()

  function getFailedBucket(key: string): ReturnType<typeof createTokenBucket> {
    let bucket = failedBuckets.get(key)
    if (bucket === undefined) {
      if (failedBuckets.size >= FAILED_BUCKET_CAP) {
        // Drop the oldest entry (first inserted; Map preserves insertion order).
        const oldestKey = failedBuckets.keys().next().value
        if (oldestKey !== undefined) failedBuckets.delete(oldestKey)
      }
      bucket = createTokenBucket({
        ratePerSec: FAILED_EXCHANGE_RATE_PER_SEC,
        burst: FAILED_EXCHANGE_BURST,
      })
      failedBuckets.set(key, bucket)
    } else {
      // Touch: move to end for LRU behaviour.
      failedBuckets.delete(key)
      failedBuckets.set(key, bucket)
    }
    return bucket
  }

  function resetFailedBucket(key: string): void {
    failedBuckets.delete(key)
    failedBuckets.set(
      key,
      createTokenBucket({
        ratePerSec: FAILED_EXCHANGE_RATE_PER_SEC,
        burst: FAILED_EXCHANGE_BURST,
      }),
    )
  }

  function peerAddrOf(req: IncomingMessage): string {
    return req.socket?.remoteAddress ?? 'unknown'
  }

  function isWithinBootWindow(): boolean {
    return now() - boot.at <= AUTO_RESET_WINDOW_MS
  }

  function getPersistedPin(): string | null {
    const trustedPath = resolveTrustedExtIdPath(projectRoot)
    return readTrustedExtId(trustedPath)
  }

  function persistPin(extId: string): void {
    const trustedPath = resolveTrustedExtIdPath(projectRoot)
    try {
      writeTrustedExtId(trustedPath, extId)
    } catch (err) {
      logger.warn('[exchange] failed to persist trusted ext-id', {
        err: (err as Error).message,
      })
      // Non-fatal: the in-memory pin still applies for the current daemon life.
    }
  }

  function resetPersistedPin(): void {
    const trustedPath = resolveTrustedExtIdPath(projectRoot)
    try {
      clearTrustedExtId(trustedPath)
    } catch (err) {
      logger.warn('[exchange] failed to clear trusted ext-id', {
        err: (err as Error).message,
      })
    }
  }

  /**
   * Decide whether an ext-ID is allowed. Returns `{ allow: true, persist }`
   * on acceptance, `{ allow: false }` on rejection.
   */
  function evaluateTofu(extId: string): { allow: true; persist: boolean } | { allow: false } {
    if (trustAnyExtension) {
      return { allow: true, persist: false }
    }
    // CLI pin always wins.
    if (pinnedExtensionId !== null) {
      return pinnedExtensionId === extId ? { allow: true, persist: false } : { allow: false }
    }
    const persisted = getPersistedPin()
    if (persisted === null) {
      // No pin yet: pin to this ext-ID.
      return { allow: true, persist: true }
    }
    if (persisted === extId) {
      return { allow: true, persist: false }
    }
    // Pin exists but this is a different ext-ID. Auto-reset?
    // Spec §3.2 literal wording lists "no file exists" as auto-reset condition 1,
    // but that case is first-use (any ext-ID pins). Auto-reset is only meaningful
    // when a pin exists and the new ext-ID differs — handled here.
    // Per spec the operative intent is "unpacked-dev-reload ext-ID churn".
    // The first successful exchange writes the pin. A subsequent reload can
    // arrive with a fresh ext-ID still inside the 10s boot window. So reset
    // when we are inside the window AND this would be the 2nd distinct origin.
    if (isWithinBootWindow() && bootWindowOrigins.size <= 1) {
      resetPersistedPin()
      return { allow: true, persist: true }
    }
    return { allow: false }
  }

  function mintSessionToken(clientNonce: string, serverNonce: string, iatSec: number): string {
    // HMAC inputs concatenated in order: clientNonce || serverNonce || iatBE8.
    // iat is encoded as an 8-byte big-endian uint64 of seconds. Fixed-width
    // encoding avoids ambiguity when any of the strings contains colons.
    const iatBE = Buffer.alloc(8)
    iatBE.writeBigUInt64BE(BigInt(iatSec))
    const mac = crypto.createHmac('sha256', rootToken)
    mac.update(Buffer.from(clientNonce, 'utf8'))
    mac.update(Buffer.from(serverNonce, 'utf8'))
    mac.update(iatBE)
    return mac.digest('base64url').replace(/=+$/, '')
  }

  async function handler(req: IncomingMessage, res: ServerResponse, reqId: string): Promise<void> {
    // Gate 0: Cookie rejection — daemon does not use cookies; a credentialed
    // request with Cookie is suspicious (CSRF/session-fixation risk).
    if (rejectCookieIfPresent(req, res, reqId)) return

    // OPTIONS preflight — handled before all other gates so browsers can
    // complete the CORS handshake without bearer credentials.
    if (req.method === 'OPTIONS') {
      handlePreflight(req, res, 'POST', reqId)
      return
    }

    // Gate 1: Sec-Fetch-Site in {none, cross-site}. When absent (non-browser
    // clients), accept — no cross-site forgery vector.
    const sfs = req.headers['sec-fetch-site']
    const sfsVal = Array.isArray(sfs) ? sfs[0] : sfs
    if (sfsVal !== undefined && sfsVal !== 'none' && sfsVal !== 'cross-site') {
      forbidUnknownExtension(
        res,
        `Sec-Fetch-Site must be none|cross-site, got ${sfsVal}`,
        reqId,
        req,
      )
      return
    }

    // Gate 2: Origin must be chrome-extension:// + 32 lowercase letters.
    const origin = req.headers.origin
    const originVal = Array.isArray(origin) ? origin[0] : origin
    if (typeof originVal !== 'string') {
      forbidUnknownExtension(res, 'Origin header missing', reqId, req)
      return
    }
    const match = ORIGIN_REGEX.exec(originVal)
    if (match === null) {
      forbidUnknownExtension(
        res,
        'Origin must be chrome-extension://<32-lowercase-letters>',
        reqId,
        req,
      )
      return
    }
    const extId = match[1]
    if (extId === undefined || !EXT_ID_REGEX.test(extId)) {
      forbidUnknownExtension(res, 'malformed extension ID', reqId, req)
      return
    }

    // Note: we track distinct origins AFTER the TOFU decision so the set size
    // at decision time represents origins seen before this request. The first
    // origin becomes size=1 (matches persisted pin); a reload with a new ext-ID
    // inside the window still has size=1 at decision time -> auto-reset allowed.

    // Rate-limit key: (Origin, peerAddr). NOT clientNonce-prefix (trivially
    // evaded by iterating nonces).
    const peerAddr = peerAddrOf(req)
    const bucketKey = `${originVal}|${peerAddr}`
    const bucket = getFailedBucket(bucketKey)

    // Pre-flight: if the bucket is empty, reject upfront. A past burst of
    // failures has drained it.
    if (!bucket.tryConsume()) {
      res.setHeader('Retry-After', String(bucket.retryAfterSec()))
      sendProblem(
        res,
        problem(429, 'TooManyRequests', 'failed-exchange rate limit exceeded', reqId),
        req,
      )
      return
    }

    // Body.
    let body: unknown
    try {
      body = await readJsonBody(req, 4 * 1024)
    } catch (e) {
      const code = (e as Error).message === 'PayloadTooLarge' ? 'PayloadTooLarge' : 'InvalidJSON'
      const status = code === 'PayloadTooLarge' ? 413 : 400
      sendProblem(res, problem(status, code, undefined, reqId), req)
      return
    }

    const parsed = BodySchema.safeParse(body)
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => i.message).join('; ')
      sendProblem(res, problem(400, 'InvalidRequest', detail, reqId), req)
      return
    }

    const { clientNonce, bootstrapToken: providedBootstrap } = parsed.data

    // Gate 4: bootstrapToken match (constant-time, via compareToken).
    if (!compareToken(providedBootstrap, bootstrapToken)) {
      sendProblem(res, problem(401, 'Unauthorized', 'invalid bootstrap token', reqId), req)
      return
    }

    // Gate 5: clientNonce one-shot within this bootstrap epoch.
    const nonceKey = `${bootstrapEpochId}:${clientNonce}`
    if (consumedNonces.has(nonceKey)) {
      sendProblem(res, problem(401, 'Unauthorized', 'clientNonce already consumed', reqId), req)
      return
    }

    // Gate 6: TOFU decision (uses pre-add bootWindowOrigins snapshot).
    const decision = evaluateTofu(extId)
    if (!decision.allow) {
      forbidUnknownExtension(res, 'extension not trusted for this project', reqId, req)
      return
    }
    // Post-decision: only successful exchanges count toward "origins connected".
    // Record now so a THIRD distinct origin (size=2 at decision time) fails
    // auto-reset even if still inside the 10s window.
    if (isWithinBootWindow()) {
      bootWindowOrigins.add(originVal)
    }

    // Mint session.
    const iatMs = now()
    const iatSec = Math.floor(iatMs / 1000)
    const serverNonce = crypto.randomBytes(24).toString('base64url').replace(/=+$/, '')
    const sessionToken = mintSessionToken(clientNonce, serverNonce, iatSec)
    const expMs = iatMs + SESSION_TTL_SEC * 1000

    // Side effects (persist pin, rotate session, consume nonce).
    if (decision.persist) {
      persistPin(extId)
    }
    activeSessions.set(extId, Buffer.from(sessionToken, 'utf8'))
    consumedNonces.add(nonceKey)
    // Bound replay-cache memory. Bootstrap rotation (future) will flush this organically.
    if (consumedNonces.size > 10_000) consumedNonces.clear()

    // Successful exchange: refund by resetting the bucket for this key.
    // Spec: only FAILED exchanges count. rateLimit.ts has no un-consume API,
    // so we reinitialize the per-key bucket to full burst on success.
    resetFailedBucket(bucketKey)

    noStorePrivate(res)
    sendJson(res, 200, {
      sessionToken,
      exp: expMs,
      serverNonce,
    })
  }

  return {
    handler,
    isSessionActive(extId: string, sessionTokenStr: string): boolean {
      const active = activeSessions.get(extId)
      if (active === undefined) return false
      return compareToken(sessionTokenStr, active)
    },
    getTrustedExtId(): string | null {
      return getPersistedPin()
    },
    rotateSession(extId: string, newSessionTokenStr: string): void {
      activeSessions.set(extId, Buffer.from(newSessionTokenStr, 'utf8'))
    },
    consumeNonce(clientNonce: string): boolean {
      const key = `${bootstrapEpochId}:${clientNonce}`
      if (consumedNonces.has(key)) return false
      consumedNonces.add(key)
      // Bound replay-cache memory (matches the cap in the handler).
      if (consumedNonces.size > 10_000) consumedNonces.clear()
      return true
    },
    getBootstrapEpochId(): string {
      return bootstrapEpochId
    },
  }
}
