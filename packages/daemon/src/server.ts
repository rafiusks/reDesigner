import crypto from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { UNAUTHORIZED_HEADERS, compareToken } from './auth.js'
import { type TokenBucket, createTokenBucket } from './rateLimit.js'
import { handleBrowserToolPost } from './routes/browserTools.js'
import { handleHealthGet } from './routes/health.js'
import { handleManifestGet } from './routes/manifest.js'
import {
  handleSelectionGet,
  handleSelectionPost,
  handleSelectionRecentGet,
} from './routes/selection.js'
import { handleShutdownPost } from './routes/shutdown.js'
import { problem, sendProblem } from './types.js'
import type { RouteContext } from './types.js'
import { attachEvents } from './ws/events.js'

// Strict loopback-literal Host check (§5 middleware #1). Blocks DNS-rebind + IP-literal variants.
const HOST_RE = /^127\.0\.0\.1:\d{1,5}$/

export interface ServerOptions {
  port: number
  token: Buffer
  ctx: RouteContext
}

export function createDaemonServer(opts: ServerOptions): {
  server: http.Server
  close: () => Promise<void>
} {
  // Rate-limit buckets — created per-server so close() isolates state.
  const unauthBucket = createTokenBucket({ ratePerSec: 10, burst: 10 })
  const getBucket = createTokenBucket({ ratePerSec: 100, burst: 100 })
  const selectionPostBucket = createTokenBucket({ ratePerSec: 120, burst: 30 })
  const computedStylesBucket = createTokenBucket({ ratePerSec: 5, burst: 5 })
  const domSubtreeBucket = createTokenBucket({ ratePerSec: 5, burst: 5 })

  const serverHeader = `@redesigner/daemon/${opts.ctx.serverVersion}`

  const server = http.createServer((req, res) => {
    // Fire-and-forget; any unhandled rejection is caught inside.
    void handle(req, res)
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reqId = crypto.randomUUID()
    res.setHeader('Server', serverHeader)

    // 1. Host allowlist — strict 127.0.0.1:<exactPort>. Pre-auth (cheap; deflects browser probes).
    const expectedHost = `127.0.0.1:${opts.port}`
    const host = req.headers.host
    if (typeof host !== 'string' || !HOST_RE.test(host) || host !== expectedHost) {
      sendProblem(
        res,
        problem(
          400,
          'HostRejected',
          `Host must be exactly ${expectedHost}; got ${host ?? ''}`,
          reqId,
        ),
      )
      return
    }

    // 2. Body size cap is applied at readJsonBody() inside each handler (streaming cutoff).

    // 3–4. Auth: extract bearer, normalized constant-time compare.
    //      Unauth bucket applies ONLY when auth is missing/invalid (valid-token bypass).
    const authHeader = req.headers.authorization
    const provided =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length)
        : undefined
    const authed = compareToken(provided, opts.token)

    if (!authed) {
      if (!unauthBucket.tryConsume()) {
        send429(res, reqId, unauthBucket)
        return
      }
      // 401 — empty body + WWW-Authenticate; problem.detail omitted to avoid info leak.
      sendProblem(res, problem(401, 'Unauthorized', undefined, reqId), UNAUTHORIZED_HEADERS)
      return
    }

    // 5–7. Auth'd — per-route-class rate limit, then dispatch.
    let url: URL
    try {
      url = new URL(req.url ?? '/', `http://${host}`)
    } catch {
      sendProblem(res, problem(400, 'InvalidRequest', 'malformed request URL', reqId))
      return
    }
    const { pathname } = url
    const method = req.method ?? ''

    try {
      // GET routes share getBucket (100/s).
      if (method === 'GET' && pathname === '/health') {
        if (!tryBucket(res, reqId, getBucket)) return
        handleHealthGet(req, res, opts.ctx)
        return
      }
      if (method === 'GET' && pathname === '/selection') {
        if (!tryBucket(res, reqId, getBucket)) return
        handleSelectionGet(req, res, opts.ctx)
        return
      }
      if (method === 'GET' && pathname === '/selection/recent') {
        if (!tryBucket(res, reqId, getBucket)) return
        handleSelectionRecentGet(req, res, opts.ctx)
        return
      }
      if (method === 'GET' && pathname === '/manifest') {
        if (!tryBucket(res, reqId, getBucket)) return
        handleManifestGet(req, res, opts.ctx)
        return
      }
      if (method === 'POST' && pathname === '/selection') {
        if (!tryBucket(res, reqId, selectionPostBucket)) return
        await handleSelectionPost(req, res, opts.ctx)
        return
      }
      if (method === 'POST' && pathname === '/computed_styles') {
        if (!tryBucket(res, reqId, computedStylesBucket)) return
        // 6. Concurrency cap for browser-tool routes is enforced inside handleBrowserToolPost
        //    via ctx.rpcCorrelation.tryAcquire() (per-ext slot reservation).
        await handleBrowserToolPost(req, res, opts.ctx, 'getComputedStyles')
        return
      }
      if (method === 'POST' && pathname === '/dom_subtree') {
        if (!tryBucket(res, reqId, domSubtreeBucket)) return
        await handleBrowserToolPost(req, res, opts.ctx, 'getDomSubtree')
        return
      }
      if (method === 'POST' && pathname === '/shutdown') {
        // /shutdown is exempt from per-route rate-limit buckets (operator-only, infrequent).
        await handleShutdownPost(req, res, opts.ctx)
        return
      }

      // Known path + wrong method → 405. Otherwise 404.
      if (isKnownPath(pathname)) {
        res.setHeader('Allow', allowedMethodsFor(pathname))
        sendProblem(
          res,
          problem(405, 'MethodNotAllowed', `method ${method} not allowed for ${pathname}`, reqId),
        )
        return
      }
      sendProblem(res, problem(404, 'NotFound', `no route for ${method} ${pathname}`, reqId))
    } catch (err: unknown) {
      // Handlers swallow their own readJsonBody errors already; anything reaching here is
      // genuinely unexpected. Log and 500.
      opts.ctx.logger.error('[server] unhandled route error', {
        err: (err as Error)?.message ?? String(err),
        reqId,
      })
      if (!res.headersSent) {
        sendProblem(res, problem(500, 'InternalError', undefined, reqId))
      } else {
        res.destroy()
      }
    }
  }

  // WS wire-up — §5 "Middleware order" applies to HTTP only; WS has its own pre-handshake auth.
  const events = attachEvents({
    server,
    port: opts.port,
    expectedToken: opts.token,
    eventBus: opts.ctx.eventBus,
    selectionState: opts.ctx.selectionState,
    manifestWatcher: opts.ctx.manifestWatcher,
    serverVersion: opts.ctx.serverVersion,
    instanceId: opts.ctx.instanceId,
    logger: opts.ctx.logger,
  })

  return {
    server,
    close: async () => {
      events.close()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}

function tryBucket(res: ServerResponse, reqId: string, bucket: TokenBucket): boolean {
  if (bucket.tryConsume()) return true
  send429(res, reqId, bucket)
  return false
}

function send429(res: ServerResponse, reqId: string, bucket: TokenBucket): void {
  res.setHeader('Retry-After', String(bucket.retryAfterSec()))
  sendProblem(res, problem(429, 'TooManyRequests', undefined, reqId))
}

function isKnownPath(pathname: string): boolean {
  return (
    pathname === '/health' ||
    pathname === '/selection' ||
    pathname === '/selection/recent' ||
    pathname === '/manifest' ||
    pathname === '/computed_styles' ||
    pathname === '/dom_subtree' ||
    pathname === '/shutdown'
  )
}

function allowedMethodsFor(pathname: string): string {
  switch (pathname) {
    case '/health':
    case '/selection/recent':
    case '/manifest':
      return 'GET'
    case '/selection':
      return 'GET, POST'
    case '/computed_styles':
    case '/dom_subtree':
    case '/shutdown':
      return 'POST'
    default:
      return ''
  }
}
