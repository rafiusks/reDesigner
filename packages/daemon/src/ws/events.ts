import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { encodeCloseReason } from '@redesigner/core/schemas'
import { type RawData, type WebSocket, WebSocketServer } from 'ws'
import { compareToken, extractBearer, extractSubprotocolToken } from '../auth.js'
import { hostAllow } from '../hostAllow.js'
import type { Logger } from '../logger.js'
import { createTokenBucket } from '../rateLimit.js'
import { CHROME_EXT_ORIGIN_REGEX } from '../routes/exchange.js'
import type { ExchangeRouteHandle } from '../routes/exchange.js'
import type { EventBus } from '../state/eventBus.js'
import type { ManifestWatcher } from '../state/manifestWatcher.js'
import type { SelectionState } from '../state/selectionState.js'
import { RpcResponseFrameSchema } from './frames.js'
import type { RpcCorrelation } from './rpcCorrelation.js'

const SINCE_RE = /^(0|[1-9][0-9]{0,15})$/
const ORIGIN_ALLOW = /^(chrome-extension:\/\/|moz-extension:\/\/|vscode-webview:\/\/)/

/**
 * Server-supported WS wire versions. Echoed back in Sec-WebSocket-Protocol as
 * `redesigner-v<max-intersection>`; also governs 4406 close rejection when the
 * client's offer doesn't overlap.
 */
export const SUPPORTED_WS_VERSIONS: readonly number[] = [1]

export function shouldRejectOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return false
  if (origin === 'null') return true
  return !ORIGIN_ALLOW.test(origin)
}

export function parseSince(raw: string | null | undefined): number | null {
  if (raw == null) return null
  if (!SINCE_RE.test(raw)) return null
  return Number(raw)
}

/**
 * Parse `?v=1,2,3` query-string version list.
 *
 *   null   → query param absent (no client constraint)
 *   []     → param present but empty / all tokens non-integer (unacceptable; caller uses to force 4406)
 *   [N…]   → deduped, desc-sorted integer versions
 *
 * Non-integer tokens are silently dropped; empty result from non-empty input is
 * what forces 4406 (rather than treating as "unspecified").
 */
export function parseQueryVersions(raw: string | null | undefined): number[] | null {
  if (raw == null) return null
  const tokens = raw.split(',').map((t) => t.trim())
  const ints: number[] = []
  for (const t of tokens) {
    if (t.length === 0) continue
    if (!/^\d+$/.test(t)) continue
    const n = Number.parseInt(t, 10)
    if (Number.isFinite(n) && n > 0 && !ints.includes(n)) ints.push(n)
  }
  ints.sort((a, b) => b - a)
  return ints
}

export interface EventsOptions {
  server: Server
  port: number
  expectedToken: Buffer
  /** Provides isSessionActive() for the session-token auth fallback. */
  exchangeRoute: ExchangeRouteHandle
  eventBus: EventBus
  selectionState: SelectionState
  manifestWatcher: ManifestWatcher
  rpcCorrelation: RpcCorrelation
  serverVersion: string
  instanceId: string
  logger: Logger
}

const PING_INTERVAL_MS = 10_000
const PONG_TIMEOUT_MS = 5_000
const MAX_PAYLOAD_BYTES = 256 * 1024

// Parse integer versions from redesigner-v<N> subprotocol entries. Deduped,
// desc-sorted so callers can use [0] as the max. Malformed entries are dropped.
function parseSubprotocolVersions(offers: readonly string[]): number[] {
  const out: number[] = []
  for (const o of offers) {
    const m = /^redesigner-v(\d+)$/.exec(o)
    if (m === null) continue
    const digits = m[1]
    if (digits === undefined) continue
    const n = Number.parseInt(digits, 10)
    if (Number.isFinite(n) && n > 0 && !out.includes(n)) out.push(n)
  }
  out.sort((a, b) => b - a)
  return out
}

function writeHttpReject(
  socket: Duplex,
  status: number,
  reason: string,
  extraHeaders?: Record<string, string>,
): void {
  try {
    const lines = [`HTTP/1.1 ${status} ${reason}`, 'Connection: close']
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) lines.push(`${k}: ${v}`)
    }
    lines.push('', '')
    socket.write(lines.join('\r\n'))
  } catch {
    // socket may already be gone
  }
  socket.destroy()
}

export function attachEvents(opts: EventsOptions): { close: () => void } {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  })
  const upgradeBucket = createTokenBucket({ ratePerSec: 5, burst: 5 })
  const isAllowedHost = hostAllow(opts.port)
  let subscriber: WebSocket | null = null

  /**
   * Complete a WS handshake that echoes exactly `echoProtocol` (or no
   * protocol at all when `echoProtocol === null`) and immediately close with
   * the given code/reason. Used when pre-handshake gating passed (version=13,
   * host, origin, rate) but subprotocol/auth/negotiation failed.
   *
   * Why echoProtocol: RFC 6455 doesn't force the server to echo a subprotocol
   * when the client offers some, but the widely-deployed `ws` client library
   * aborts the handshake ("Server sent no subprotocol") when it offered and
   * the server didn't echo. That aborts BEFORE the close frame is read, so
   * the client sees abnormal closure (1006) instead of our intended 1002/
   * 4406. To deliver the structured close code we echo a safe value (never
   * the bearer; always drawn from the client's offer set so the client's
   * subprotocol validation accepts it) and then close.
   *
   * When the client offered nothing echoable (e.g. bearer-only), there's no
   * safe echo. We drop the socket; the client observes 1006 / disconnect,
   * which is acceptable for the pathological cases that hit this branch.
   */
  const handshakeAndClose = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    code: number,
    reasonText: string,
    echoProtocol: string | null,
  ): void => {
    if (echoProtocol !== null) {
      req.headers['sec-websocket-protocol'] = echoProtocol
    } else {
      // Clear via undefined assignment (biome noDelete rule); ws reads the
      // header key, so undefined is treated as "absent".
      req.headers['sec-websocket-protocol'] = undefined
    }
    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('error', () => {
          /* client dropped during close handshake; nothing to clean up */
        })
        try {
          ws.close(code, reasonText)
        } catch {
          try {
            ws.terminate()
          } catch {
            // ignore
          }
        }
      })
    } catch {
      // If ws rejected the handshake (e.g. bad Sec-WebSocket-Key), drop the
      // socket. The client observes a socket-level disconnect.
      try {
        socket.destroy()
      } catch {
        // ignore
      }
    }
  }

  /**
   * Pick a subprotocol to echo on a failure-close path. Rules:
   *   - Never the bearer-prefixed entry.
   *   - Prefer any versioned offer (matches /^redesigner-v\d+$/).
   *   - Fall back to any other client-offered entry (still not the bearer).
   *   - Return null if nothing safe is available; caller drops the socket.
   */
  const pickSafeEchoProtocol = (entries: readonly string[]): string | null => {
    for (const e of entries) {
      if (/^redesigner-v\d+$/.test(e)) return e
    }
    for (const e of entries) {
      if (!e.startsWith('base64url.bearer.authorization.')) return e
    }
    return null
  }

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const rawUrl = req.url ?? '/'
    let url: URL
    try {
      url = new URL(rawUrl, `http://${req.headers.host ?? '127.0.0.1'}`)
    } catch {
      writeHttpReject(socket, 400, 'Bad Request')
      return
    }
    if (url.pathname !== '/events') {
      socket.destroy()
      return
    }

    // 0. RFC 6455 §4.1: Sec-WebSocket-Version MUST be 13. Any other value → 426
    //    Upgrade Required with a Sec-WebSocket-Version response header advertising
    //    the server's supported version. This runs BEFORE host/origin so a stale
    //    or misconfigured client gets the definitive "upgrade your client" signal.
    const wsVersion = req.headers['sec-websocket-version']
    if (wsVersion !== '13') {
      opts.logger.warn('[ws] unsupported Sec-WebSocket-Version', {
        got: typeof wsVersion === 'string' ? wsVersion : null,
      })
      writeHttpReject(socket, 426, 'Upgrade Required', { 'Sec-WebSocket-Version': '13' })
      return
    }

    // 1. Host allowlist — shared literal set via hostAllow(): localhost:<port>,
    //    127.0.0.1:<port>, [::1]:<port>. Mismatch → 421 Misdirected Request
    //    (matches HTTP path; spec §3.2).
    if (!isAllowedHost(req.headers.host)) {
      opts.logger.warn('[ws] host rejected', { host: req.headers.host ?? null })
      writeHttpReject(socket, 421, 'Misdirected Request')
      return
    }

    // 2. Origin deny-by-default.
    const originHeader = req.headers.origin
    const origin = typeof originHeader === 'string' ? originHeader : undefined
    if (shouldRejectOrigin(origin)) {
      opts.logger.warn('[ws] origin rejected', { origin: origin ?? null })
      writeHttpReject(socket, 403, 'Forbidden')
      return
    }

    // 3. Upgrade rate limit (global per daemon).
    if (!upgradeBucket.tryConsume()) {
      opts.logger.warn('[ws] upgrade rate limit')
      writeHttpReject(socket, 429, 'Too Many Requests')
      return
    }

    // 4. Subprotocol parse + version negotiation + auth.
    //
    //    Past this point, the request has cleared pre-handshake gating (valid
    //    WS version, host, origin, rate). Any further rejection goes as a
    //    WebSocket close frame (post-handshake), not an HTTP status — giving
    //    a uniform client-observed behavior and avoiding auth-oracle leaks.
    const subproto = extractSubprotocolToken(req)

    // 4a. Too many subprotocol entries → 1002 protocol error. We still
    //     complete the handshake (echoing a safe, non-bearer entry from the
    //     client's own offer so their ws-client accepts the subprotocol ack)
    //     so the client receives the structured close code.
    if (subproto.tooMany) {
      opts.logger.warn('[ws] subprotocol entries exceeded cap', {
        count: subproto.entries.length,
      })
      const echo = pickSafeEchoProtocol(subproto.entries)
      handshakeAndClose(req, socket, head, 1002, 'protocol error', echo)
      return
    }

    // 4b. No versioned offer at all (bearer-only or no redesigner-v*). No
    //     safe non-bearer entry to echo → drop the socket (client sees 1006).
    //     This is the one pathological case where we can't deliver a code.
    if (subproto.versionedOffers.length === 0) {
      opts.logger.warn('[ws] no redesigner-v* subprotocol offered')
      const echo = pickSafeEchoProtocol(subproto.entries)
      handshakeAndClose(req, socket, head, 1002, 'protocol error', echo)
      return
    }

    // 4c. Version negotiation: intersect subprotocol versions with optional
    //     ?v= constraint, then intersect with server-supported versions.
    const subprotoVersions = parseSubprotocolVersions(subproto.versionedOffers)
    const qVersions = parseQueryVersions(url.searchParams.get('v'))
    let candidate = subprotoVersions
    if (qVersions !== null) {
      const set = new Set(qVersions)
      candidate = candidate.filter((v) => set.has(v))
    }
    const supportedSet = new Set(SUPPORTED_WS_VERSIONS)
    const accepted = candidate.filter((v) => supportedSet.has(v))
    if (accepted.length === 0) {
      opts.logger.warn('[ws] version negotiation failed', {
        subproto: subprotoVersions,
        q: qVersions,
      })
      let reason: string
      try {
        reason = encodeCloseReason({ accepted: [...SUPPORTED_WS_VERSIONS] })
      } catch {
        socket.destroy()
        return
      }
      // Echo the client's first versioned offer so their ws-client accepts
      // the subprotocol ack and processes the 4406 close frame.
      const echo = subproto.versionedOffers[0] ?? null
      handshakeAndClose(req, socket, head, 4406, reason, echo)
      return
    }
    // candidate (and thus accepted) is desc-sorted; length > 0 checked above.
    const negotiatedV = accepted[0] as number
    const chosenSubproto = `redesigner-v${negotiatedV}`

    // 4d. Bearer auth — prefer subprotocol bearer (browser shape), fall back
    //     to Authorization header (native clients). If the bearer doesn't
    //     match the daemon authToken, treat it as a session token minted via
    //     /__redesigner/exchange — valid iff the Origin is a pinned
    //     chrome-extension:// and isSessionActive(extId, bearer) is true.
    //     Uniform 1002 on failure.
    const providedBearer = subproto.bearer ?? extractBearer(req)
    let authed = compareToken(providedBearer, opts.expectedToken)
    if (!authed && providedBearer !== undefined) {
      const originHeader = req.headers.origin
      const originVal = Array.isArray(originHeader) ? originHeader[0] : originHeader
      if (typeof originVal === 'string') {
        const match = CHROME_EXT_ORIGIN_REGEX.exec(originVal)
        if (match?.[1]) {
          authed = opts.exchangeRoute.isSessionActive(match[1], providedBearer)
        }
      }
    }
    if (!authed) {
      opts.logger.warn('[ws] token mismatch; closing 1002')
      handshakeAndClose(req, socket, head, 1002, 'protocol error', chosenSubproto)
      return
    }

    // 5. ?since= parse. Invalid → 1002 (post-gating).
    const sinceRaw = url.searchParams.get('since')
    const since = sinceRaw === null ? undefined : (parseSince(sinceRaw) ?? 'invalid')
    if (since === 'invalid') {
      handshakeAndClose(req, socket, head, 1002, 'protocol error', chosenSubproto)
      return
    }

    // Rewrite the subprotocol header to just the chosen entry so ws's default
    // selector (first-in-set wins) echoes exactly `redesigner-v<N>` and
    // nothing else — in particular, never the bearer entry.
    req.headers['sec-websocket-protocol'] = chosenSubproto

    wss.handleUpgrade(req, socket, head, (ws) => {
      // Second concurrent subscriber → close 4409 after handshake (per spec).
      if (subscriber !== null) {
        opts.logger.warn('[ws] rejected: already subscribed')
        ws.close(4409, 'already subscribed')
        return
      }
      subscriber = ws
      opts.eventBus.addSubscriber(ws)

      const current = opts.eventBus.currentSeq()
      const decision = opts.eventBus.computeResync(since, current)

      // Emit hello frame (always current snapshot; hello does NOT advance seq).
      const snap = opts.selectionState.snapshot()
      const manifest = opts.manifestWatcher.getCached()
      const helloFrame = {
        type: 'hello' as const,
        seq: current,
        payload: {
          serverVersion: opts.serverVersion,
          instanceId: opts.instanceId,
          snapshotSeq: current,
          negotiatedV,
          snapshot: {
            current: snap.current,
            recent: snap.recent.slice(0, 10),
            manifestMeta: manifest
              ? {
                  contentHash: manifest.contentHash,
                  componentCount: opts.manifestWatcher.getComponentCount(),
                }
              : null,
          },
        },
      }
      try {
        ws.send(JSON.stringify(helloFrame))
      } catch (err) {
        opts.logger.warn('[ws] hello send failed', { err: String(err) })
      }

      if (decision.kind === 'hello-gap') {
        const gapSeq = opts.eventBus.mintSeq()
        opts.eventBus.recordFrame({ seq: gapSeq, type: 'resync.gap' })
        try {
          ws.send(
            JSON.stringify({
              type: 'resync.gap',
              seq: gapSeq,
              payload: {
                droppedFrom: decision.droppedFrom,
                droppedTo: decision.droppedTo,
              },
            }),
          )
        } catch (err) {
          opts.logger.warn('[ws] resync.gap send failed', { err: String(err) })
        }
      }

      // Keep-alive: ping every 10s; 5s pong timeout → close 4408.
      let pongTimer: NodeJS.Timeout | null = null
      const onPong = (): void => {
        if (pongTimer) {
          clearTimeout(pongTimer)
          pongTimer = null
        }
      }
      ws.on('pong', onPong)

      const pingInterval = setInterval(() => {
        if (ws.readyState !== ws.OPEN) return
        if (pongTimer) return // previous pong still pending; don't stack
        try {
          ws.ping()
        } catch {
          return
        }
        pongTimer = setTimeout(() => {
          pongTimer = null
          opts.logger.warn('[ws] pong timeout; closing 4408')
          try {
            ws.close(4408, 'pong timeout')
          } catch {
            // ignore
          }
        }, PONG_TIMEOUT_MS)
        pongTimer.unref?.()
      }, PING_INTERVAL_MS)
      pingInterval.unref?.()

      // Extension → daemon wire: the ext replies to rpc.request frames with
      // rpc.response frames. Parse, validate, and correlate by JSON-RPC id.
      const onMessage = (data: RawData, isBinary: boolean): void => {
        if (isBinary) {
          opts.logger.warn('[ws] unexpected binary frame from subscriber; dropping')
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(data.toString())
        } catch {
          opts.logger.warn('[ws] subscriber sent non-JSON; dropping')
          return
        }
        const result = RpcResponseFrameSchema.safeParse(parsed)
        if (!result.success) {
          opts.logger.warn('[ws] subscriber sent unknown/malformed frame; dropping')
          return
        }
        const payload = result.data.payload
        if ('result' in payload) {
          opts.rpcCorrelation.resolve(payload.id, payload.result)
        } else {
          opts.rpcCorrelation.reject(payload.id, new Error(`rpc error: ${payload.error.message}`))
        }
      }
      ws.on('message', onMessage)

      ws.on('close', () => {
        clearInterval(pingInterval)
        if (pongTimer) {
          clearTimeout(pongTimer)
          pongTimer = null
        }
        ws.off('pong', onPong)
        ws.off('message', onMessage)
        if (subscriber === ws) subscriber = null
        // Fail any in-flight RPCs awaiting this subscriber. The router's
        // error taxonomy maps messages containing "disconnected" → 503
        // ExtensionDisconnected with Retry-After: 2.
        opts.rpcCorrelation.rejectAll(new Error('ext disconnected'))
      })

      ws.on('error', (err) => {
        opts.logger.warn('[ws] subscriber error', { err: String(err) })
      })
    })
  }

  opts.server.on('upgrade', handleUpgrade)

  return {
    close: () => {
      opts.server.off('upgrade', handleUpgrade)
      wss.close()
    },
  }
}
