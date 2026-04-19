import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { type WebSocket, WebSocketServer } from 'ws'
import { compareToken, extractBearer } from '../auth.js'
import type { Logger } from '../logger.js'
import { createTokenBucket } from '../rateLimit.js'
import type { EventBus } from '../state/eventBus.js'
import type { ManifestWatcher } from '../state/manifestWatcher.js'
import type { SelectionState } from '../state/selectionState.js'

const SINCE_RE = /^(0|[1-9][0-9]{0,15})$/
const ORIGIN_ALLOW = /^(chrome-extension:\/\/|moz-extension:\/\/|vscode-webview:\/\/)/

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

export interface EventsOptions {
  server: Server
  port: number
  expectedToken: Buffer
  eventBus: EventBus
  selectionState: SelectionState
  manifestWatcher: ManifestWatcher
  serverVersion: string
  instanceId: string
  logger: Logger
}

const PING_INTERVAL_MS = 10_000
const PONG_TIMEOUT_MS = 5_000
const MAX_PAYLOAD_BYTES = 256 * 1024

function writeHttpReject(socket: Duplex, status: number, reason: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
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
  let subscriber: WebSocket | null = null

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

    // 1. Host allowlist (strict 127.0.0.1:<port>, not localhost).
    const expectedHost = `127.0.0.1:${opts.port}`
    if (req.headers.host !== expectedHost) {
      opts.logger.warn('[ws] host rejected', { host: req.headers.host ?? null })
      writeHttpReject(socket, 400, 'Bad Request')
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

    // 4. Token validation (normalized timingSafeEqual via compareToken).
    const provided = extractBearer(req)
    if (!compareToken(provided, opts.expectedToken)) {
      writeHttpReject(socket, 401, 'Unauthorized')
      return
    }

    // 5. ?since= parse.
    const sinceRaw = url.searchParams.get('since')
    const since = sinceRaw === null ? undefined : (parseSince(sinceRaw) ?? 'invalid')
    if (since === 'invalid') {
      writeHttpReject(socket, 400, 'Bad Request')
      return
    }

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
          snapshot: {
            current: snap.current,
            recent: snap.recent.slice(0, 10),
            manifestMeta: manifest
              ? {
                  contentHash: manifest.contentHash,
                  componentCount: Object.keys(manifest.components).length,
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

      ws.on('close', () => {
        clearInterval(pingInterval)
        if (pongTimer) {
          clearTimeout(pongTimer)
          pongTimer = null
        }
        ws.off('pong', onPong)
        if (subscriber === ws) subscriber = null
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
