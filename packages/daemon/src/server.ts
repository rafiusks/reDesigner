import crypto from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { UNAUTHORIZED_HEADERS, compareToken, extractBearer } from './auth.js'
import { hostAllow } from './hostAllow.js'
import { type TokenBucket, createTokenBucket } from './rateLimit.js'
import { handleBrowserToolPost } from './routes/browserTools.js'
import { handleHealthGet } from './routes/health.js'
import { handleManifestGet } from './routes/manifest.js'
import {
  handleSelectionGet,
  handleSelectionPut,
  handleSelectionRecentGet,
} from './routes/selection.js'
import { handleShutdownPost } from './routes/shutdown.js'
import { problem, sendProblem } from './types.js'
import type { RouteContext } from './types.js'
import { attachEvents } from './ws/events.js'

export interface ServerOptions {
  port: number
  token: Buffer
  ctx: RouteContext
}

// Regex for /tabs/<positive-integer>/selection — compiled once at module level.
const TABS_SELECTION_RE = /^\/tabs\/(\d+)\/selection$/

export function createDaemonServer(opts: ServerOptions): {
  server: http.Server
  close: () => Promise<void>
} {
  // Rate-limit buckets — created per-server so close() isolates state.
  const unauthBucket = createTokenBucket({ ratePerSec: 10, burst: 10 })
  const getBucket = createTokenBucket({ ratePerSec: 100, burst: 100 })
  const selectionPutBucket = createTokenBucket({ ratePerSec: 120, burst: 30 })
  const computedStylesBucket = createTokenBucket({ ratePerSec: 5, burst: 5 })
  const domSubtreeBucket = createTokenBucket({ ratePerSec: 5, burst: 5 })

  const serverHeader = `@redesigner/daemon/${opts.ctx.serverVersion}`
  const isAllowedHost = hostAllow(opts.port)

  const server = http.createServer((req, res) => {
    // Fire-and-forget; any unhandled rejection is caught inside.
    void handle(req, res)
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reqId = crypto.randomUUID()
    res.setHeader('Server', serverHeader)

    // 1. Host allowlist — literal set { localhost, 127.0.0.1, [::1] } at the daemon's port.
    //    Broader than 127.0.0.1-only (prior) so extensions that resolve localhost get through,
    //    while DNS-rebind suffixes and non-loopback IPs are still rejected.
    //    Per spec §3.2 mismatch returns 421 Misdirected Request (not 400).
    const host = req.headers.host
    if (!isAllowedHost(host)) {
      sendProblem(
        res,
        problem(
          421,
          'HostRejected',
          `Host must be one of localhost:${opts.port}, 127.0.0.1:${opts.port}, [::1]:${opts.port}; got ${host ?? ''}`,
          reqId,
        ),
      )
      return
    }

    // 2. Body size cap is applied at readJsonBody() inside each handler (streaming cutoff).

    // 3–4. Auth: extract bearer, normalized constant-time compare.
    //      Unauth bucket applies ONLY when auth is missing/invalid (valid-token bypass).
    const authed = compareToken(extractBearer(req), opts.token)

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

      // Legacy /selection path — gone entirely (410) regardless of HTTP method.
      // Path resolution precedes method dispatch: POST /selection also returns 410.
      // GET /selection is excluded above (backward-compat snapshot read stays).
      if (pathname === '/selection' && method !== 'GET') {
        const p = problem(
          410,
          'Gone',
          'This endpoint has moved to PUT /tabs/{tabId}/selection',
          reqId,
        )
        const body: typeof p & { apiErrorCode: string } = { ...p, apiErrorCode: 'endpoint-moved' }
        res.statusCode = 410
        res.setHeader('Content-Type', 'application/problem+json')
        res.end(JSON.stringify(body))
        return
      }

      // /tabs/{tabId}/selection — tab-scoped resource (Task 10).
      // Path resolution runs first; method dispatch is secondary.
      const tabsMatch = TABS_SELECTION_RE.exec(pathname)
      if (tabsMatch !== null) {
        const tabIdRaw = Number(tabsMatch[1])
        // Validate: positive integer (chrome tab IDs are always positive)
        if (!Number.isInteger(tabIdRaw) || tabIdRaw <= 0) {
          sendProblem(
            res,
            problem(400, 'InvalidRequest', 'tabId must be a positive integer', reqId),
          )
          return
        }
        if (method === 'PUT') {
          if (!tryBucket(res, reqId, selectionPutBucket)) return
          await handleSelectionPut(req, res, opts.ctx, tabIdRaw)
          return
        }
        // Wrong method on this known path → 405 with Allow header.
        // No Deprecation/Sunset headers (POST was never supported here).
        res.setHeader('Allow', 'PUT')
        const p = problem(
          405,
          'MethodNotAllowed',
          `method ${method} not allowed for ${pathname}`,
          reqId,
        )
        const body: typeof p & { apiErrorCode: string } = {
          ...p,
          apiErrorCode: 'method-not-allowed',
        }
        res.statusCode = 405
        res.setHeader('Content-Type', 'application/problem+json')
        res.end(JSON.stringify(body))
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
    rpcCorrelation: opts.ctx.rpcCorrelation,
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
      return 'GET'
    case '/computed_styles':
    case '/dom_subtree':
    case '/shutdown':
      return 'POST'
    default:
      return ''
  }
}
