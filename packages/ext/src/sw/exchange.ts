/**
 * SW exchange controller — bootstrap → session token lifecycle.
 *
 * Spec §3/§4:
 *  - ensureSession() returns a valid sessionToken. If missing or within
 *    refreshLeadMs (default 60s) of expiry, POSTs /__redesigner/exchange.
 *  - Each exchange generates a fresh clientNonce (one-shot; defense-in-depth
 *    even though the daemon only enforces one-shot per bootstrap epoch).
 *  - handshake.rotated (new bootstrapToken) invalidates the current session
 *    and re-exchanges immediately.
 *  - hello.serverNonceEcho must equal the serverNonce the daemon returned on
 *    the exchange that minted the current session token. Mismatch means the
 *    exchange response was replayed and the WS must be aborted.
 *  - 1002-cap-exhaust: WS-layer signals to the SW that repeated auth failures
 *    mean the bootstrap is stale; the SW asks its CSes to re-fetch handshake
 *    and then re-exchanges. The CS signaling hook is injected.
 */

import { postExchange as defaultPostExchange } from './rest.js'

export interface ExchangeState {
  readonly sessionToken: string | null
  readonly sessionExp: number | null
  readonly serverNonce: string | null
  readonly bootstrapToken: string | null
  readonly httpUrl: string | null
  readonly wsUrl: string | null
}

export interface ExchangeController {
  state(): ExchangeState
  setBootstrap(args: { bootstrapToken: string; httpUrl: string; wsUrl: string }): void
  ensureSession(now?: number): Promise<string>
  handleRotated(newBootstrap: string): Promise<void>
  verifyServerNonceEcho(helloFrame: { serverNonceEcho?: string | null }): boolean
  invalidateSession(): void
  scheduleCsHandshakeRefetch(): void
}

export interface ExchangeControllerOptions {
  rest?: { postExchange: typeof defaultPostExchange }
  persist?: (state: ExchangeState) => Promise<void>
  now?: () => number
  generateClientNonce?: () => string
  refreshLeadMs?: number
  onCsHandshakeRefetch?: () => void
}

const DEFAULT_REFRESH_LEAD_MS = 60_000

function defaultClientNonce(): string {
  // crypto.randomUUID() is 36 chars; schema requires >=16, opaque, URL-safe.
  return crypto.randomUUID()
}

/**
 * Constant-time-ish string compare for opaque base64url tokens.
 * Tokens are server-generated; a length mismatch is itself a signal. We
 * length-normalize before XOR'ing to avoid early-exit timing leaks.
 */
function safeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export function createExchangeController(opts: ExchangeControllerOptions = {}): ExchangeController {
  const postExchange = opts.rest?.postExchange ?? defaultPostExchange
  const persist = opts.persist
  const now = opts.now ?? (() => Date.now())
  const generateClientNonce = opts.generateClientNonce ?? defaultClientNonce
  const refreshLeadMs = opts.refreshLeadMs ?? DEFAULT_REFRESH_LEAD_MS
  const onCsHandshakeRefetch = opts.onCsHandshakeRefetch

  let sessionToken: string | null = null
  let sessionExp: number | null = null
  let serverNonce: string | null = null
  let bootstrapToken: string | null = null
  let httpUrl: string | null = null
  let wsUrl: string | null = null

  // Single-flight guard — multiple concurrent ensureSession() calls share one
  // in-flight exchange.
  let inFlight: Promise<string> | null = null

  function snapshot(): ExchangeState {
    return {
      sessionToken,
      sessionExp,
      serverNonce,
      bootstrapToken,
      httpUrl,
      wsUrl,
    }
  }

  async function persistIfPresent(): Promise<void> {
    if (persist === undefined) return
    try {
      await persist(snapshot())
    } catch {
      // Persistence is best-effort; the in-memory state is authoritative for
      // the life of the SW. A hydrate miss forces a fresh exchange anyway.
    }
  }

  function tokenIsFresh(nowMs: number): boolean {
    return sessionToken !== null && sessionExp !== null && sessionExp > nowMs + refreshLeadMs
  }

  async function performExchange(): Promise<string> {
    if (bootstrapToken === null || httpUrl === null) {
      throw new Error('exchange: bootstrap not set — call setBootstrap() first')
    }
    const clientNonce = generateClientNonce()
    const res = await postExchange({
      httpUrl,
      clientNonce,
      bootstrapToken,
    })
    sessionToken = res.sessionToken
    sessionExp = res.exp
    serverNonce = res.serverNonce
    await persistIfPresent()
    return sessionToken
  }

  async function ensureSession(nowArg?: number): Promise<string> {
    const t = nowArg ?? now()
    if (tokenIsFresh(t) && sessionToken !== null) {
      return sessionToken
    }
    if (inFlight !== null) return inFlight
    inFlight = performExchange().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  function invalidateSession(): void {
    sessionToken = null
    sessionExp = null
    serverNonce = null
    // persist so a restarting SW doesn't pick up a stale session.
    void persistIfPresent()
  }

  async function handleRotated(newBootstrap: string): Promise<void> {
    bootstrapToken = newBootstrap
    sessionToken = null
    sessionExp = null
    serverNonce = null
    await persistIfPresent()
    await ensureSession()
  }

  function verifyServerNonceEcho(helloFrame: { serverNonceEcho?: string | null }): boolean {
    const echo = helloFrame.serverNonceEcho
    if (typeof echo !== 'string' || serverNonce === null) return false
    return safeStringEqual(echo, serverNonce)
  }

  function scheduleCsHandshakeRefetch(): void {
    onCsHandshakeRefetch?.()
  }

  return {
    state: snapshot,
    setBootstrap(args) {
      bootstrapToken = args.bootstrapToken
      httpUrl = args.httpUrl
      wsUrl = args.wsUrl
    },
    ensureSession,
    handleRotated,
    verifyServerNonceEcho,
    invalidateSession,
    scheduleCsHandshakeRefetch,
  }
}
