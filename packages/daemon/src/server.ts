import crypto from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { UNAUTHORIZED_HEADERS, compareToken, extractBearer } from './auth.js'
import { hostAllow } from './hostAllow.js'
import { problem, sendProblem } from './problem.js'
import { type TokenBucket, createTokenBucket } from './rateLimit.js'
import { handleBrowserToolPost } from './routes/browserTools.js'
import {
  applyCorsHeaders,
  handlePreflight,
  noStorePrivate,
  rejectCookieIfPresent,
} from './routes/cors.js'
import { handleDebugStateGet } from './routes/debug.js'
import { createExchangeRoute } from './routes/exchange.js'
import { handleHealthGet } from './routes/health.js'
import { handleManifestGet } from './routes/manifest.js'
import { createRevalidateRoute } from './routes/revalidate.js'
import {
  handleSelectionGet,
  handleSelectionPut,
  handleSelectionRecentGet,
} from './routes/selection.js'
import { handleShutdownPost } from './routes/shutdown.js'
import type { RouteContext } from './types.js'
import { sendJson } from './types.js'
import { attachEvents } from './ws/events.js'

export interface ServerOptions {
  port: number
  token: Buffer
  bootstrapToken: Buffer
  rootToken: Buffer
  ctx: RouteContext
}

// Regex for /tabs/<positive-integer>/selection — compiled once at module level.
const TABS_SELECTION_RE = /^\/tabs\/(\d+)\/selection$/

// OPTIONS method-set table: pathname (or prefix) → allowed methods string.
// Ordered by specificity; the first match wins. Dynamic paths (/tabs/*/selection)
// are handled inline.
const OPTIONS_TABLE: Array<{ path: string; methods: string }> = [
  { path: '/health', methods: 'GET' },
  { path: '/selection/recent', methods: 'GET' },
  { path: '/selection', methods: 'GET' },
  { path: '/manifest', methods: 'GET' },
  { path: '/computed_styles', methods: 'POST' },
  { path: '/dom_subtree', methods: 'POST' },
  { path: '/shutdown', methods: 'POST' },
  { path: '/__redesigner/exchange', methods: 'POST' },
  { path: '/__redesigner/revalidate', methods: 'POST' },
]

export function createDaemonServer(opts: ServerOptions): {
  server: http.Server
  close: () => Promise<void>
} {
  // Env gate for debug routes — evaluated at server-creation time so the server
  // instance is consistent for its lifetime.
  const debugEnabled = process.env.REDESIGNER_DEBUG === '1'

  // Rate-limit buckets — created per-server so close() isolates state.
  const unauthBucket = createTokenBucket({ ratePerSec: 10, burst: 10 })
  const getBucket = createTokenBucket({ ratePerSec: 100, burst: 100 })
  const selectionPutBucket = createTokenBucket({ ratePerSec: 120, burst: 30 })
  const computedStylesBucket = createTokenBucket({ ratePerSec: 5, burst: 5 })
  const domSubtreeBucket = createTokenBucket({ ratePerSec: 5, burst: 5 })

  const serverHeader = `@redesigner/daemon/${opts.ctx.serverVersion}`
  const isAllowedHost = hostAllow(opts.port)

  // Exchange + revalidate: constructed once per server instance so their
  // in-memory state (consumed-nonce set, active-session map, per-origin
  // failed-exchange buckets, TOFU pin cache) is consistent across requests.
  // Revalidate shares the exchange handle so it can see the same nonce set
  // and rotate the same active-session entries.
  const exchangeRoute = createExchangeRoute({
    rootToken: opts.rootToken,
    bootstrapToken: opts.bootstrapToken,
    projectRoot: opts.ctx.projectRoot,
    logger: opts.ctx.logger,
  })
  const revalidateRoute = createRevalidateRoute({
    exchange: exchangeRoute,
    rootToken: opts.rootToken,
    projectRoot: opts.ctx.projectRoot,
    logger: opts.ctx.logger,
  })

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
        req,
      )
      return
    }

    // 2. Body size cap is applied at readJsonBody() inside each handler (streaming cutoff).

    // 3. Parse URL early (needed for method dispatch and OPTIONS).
    let url: URL
    try {
      url = new URL(req.url ?? '/', `http://${host}`)
    } catch {
      sendProblem(res, problem(400, 'InvalidRequest', 'malformed request URL', reqId), req)
      return
    }
    const { pathname } = url
    const method = req.method ?? ''

    // 4. OPTIONS short-circuit — preflight handling before auth.
    //    OPTIONS must be handled before auth so browsers can complete the
    //    CORS preflight without needing credentials.
    if (method === 'OPTIONS') {
      // Dynamic tab-scoped path.
      if (TABS_SELECTION_RE.test(pathname)) {
        handlePreflight(req, res, 'PUT', reqId)
        return
      }
      // Static path lookup.
      const entry = OPTIONS_TABLE.find((e) => e.path === pathname)
      if (entry !== undefined) {
        handlePreflight(req, res, entry.methods, reqId)
        return
      }
      // Unknown path: 404 with Vary.
      sendProblem(res, problem(404, 'NotFound', `no route for OPTIONS ${pathname}`, reqId), req)
      return
    }

    // Pre-auth carve-out: /__redesigner/* routes authenticate via their own
    // request-body tokens, Origin gate, and Sec-Fetch-Site gate (see
    // routes/exchange.ts + routes/revalidate.ts). They MUST bypass the Bearer
    // check below, because no legitimate client can have the daemon's
    // authToken before completing an exchange.
    //
    // SECURITY: exact pathname match, POST only. Any pathname normalization
    // or prefix match here would be a Bearer-auth bypass for every route.
    // The unauth bucket caps bootstrap-attempt rate independent of the
    // per-(Origin, peerAddr) buckets inside each handler.
    if (method === 'POST' && pathname === '/__redesigner/exchange') {
      if (!tryBucket(res, req, reqId, unauthBucket)) return
      await exchangeRoute.handler(req, res, reqId)
      return
    }
    if (method === 'POST' && pathname === '/__redesigner/revalidate') {
      if (!tryBucket(res, req, reqId, unauthBucket)) return
      await revalidateRoute.handler(req, res, reqId)
      return
    }

    // 5–7. Auth: extract bearer, normalized constant-time compare.
    //      Unauth bucket applies ONLY when auth is missing/invalid (valid-token bypass).
    const authed = compareToken(extractBearer(req), opts.token)

    if (!authed) {
      if (!unauthBucket.tryConsume()) {
        send429(res, req, reqId, unauthBucket)
        return
      }
      // 401 — empty body + WWW-Authenticate; problem.detail omitted to avoid info leak.
      sendProblem(res, problem(401, 'Unauthorized', undefined, reqId), req, UNAUTHORIZED_HEADERS)
      return
    }

    // 8. Auth'd — per-route-class rate limit, then dispatch.
    try {
      // GET routes share getBucket (100/s).
      if (method === 'GET' && pathname === '/health') {
        if (!tryBucket(res, req, reqId, getBucket)) return
        // Apply CORS + no-store (health is public status but still CORS-reachable).
        applyCorsHeaders(res, req)
        handleHealthGet(req, res, opts.ctx)
        return
      }
      if (method === 'GET' && pathname === '/selection') {
        if (!tryBucket(res, req, reqId, getBucket)) return
        if (rejectCookieIfPresent(req, res, reqId)) return
        // Apply CORS headers; noStorePrivate is called inside handler via sendJson wrapper.
        applyCorsHeaders(res, req)
        noStorePrivate(res)
        handleSelectionGet(req, res, opts.ctx)
        return
      }
      if (method === 'GET' && pathname === '/selection/recent') {
        if (!tryBucket(res, req, reqId, getBucket)) return
        if (rejectCookieIfPresent(req, res, reqId)) return
        applyCorsHeaders(res, req)
        noStorePrivate(res)
        handleSelectionRecentGet(req, res, opts.ctx)
        return
      }
      if (method === 'GET' && pathname === '/manifest') {
        if (!tryBucket(res, req, reqId, getBucket)) return
        applyCorsHeaders(res, req)
        handleManifestGet(req, res, opts.ctx)
        return
      }

      // Legacy /selection path — gone entirely (410) regardless of HTTP method.
      // Path resolution precedes method dispatch: POST /selection also returns 410.
      // GET /selection is excluded above (backward-compat snapshot read stays).
      if (pathname === '/selection' && method !== 'GET') {
        applyCorsHeaders(res, req)
        noStorePrivate(res)
        const p = problem(
          410,
          'Gone',
          'This endpoint has moved to PUT /tabs/{tabId}/selection',
          reqId,
        )
        const body: typeof p & { apiErrorCode: string } = { ...p, apiErrorCode: 'endpoint-moved' }
        res.statusCode = 410
        res.setHeader('Content-Type', 'application/problem+json; charset=utf-8')
        res.end(JSON.stringify(body))
        return
      }

      // /tabs/{tabId}/selection — tab-scoped resource (Task 10).
      // Path resolution runs first; method dispatch is secondary.
      const tabsMatch = TABS_SELECTION_RE.exec(pathname)
      if (tabsMatch !== null) {
        const tabIdRaw = Number(tabsMatch[1])
        // Validate: positive integer within safe range (chrome tab IDs are always positive)
        if (!Number.isInteger(tabIdRaw) || tabIdRaw <= 0 || tabIdRaw > Number.MAX_SAFE_INTEGER) {
          sendProblem(res, problem(400, 'InvalidRequest', 'tabId out of range', reqId), req)
          return
        }
        if (method === 'PUT') {
          if (!tryBucket(res, req, reqId, selectionPutBucket)) return
          if (rejectCookieIfPresent(req, res, reqId)) return
          applyCorsHeaders(res, req)
          noStorePrivate(res)
          await handleSelectionPut(req, res, opts.ctx, tabIdRaw)
          return
        }
        // Wrong method on this known path → 405 with Allow header.
        // No Deprecation/Sunset headers (POST was never supported here).
        res.setHeader('Allow', 'PUT')
        applyCorsHeaders(res, req)
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
        res.setHeader('Content-Type', 'application/problem+json; charset=utf-8')
        res.end(JSON.stringify(body))
        return
      }

      if (method === 'POST' && pathname === '/computed_styles') {
        if (!tryBucket(res, req, reqId, computedStylesBucket)) return
        applyCorsHeaders(res, req)
        // 6. Concurrency cap for browser-tool routes is enforced inside handleBrowserToolPost
        //    via ctx.rpcCorrelation.tryAcquire() (per-ext slot reservation).
        await handleBrowserToolPost(req, res, opts.ctx, 'getComputedStyles')
        return
      }
      if (method === 'POST' && pathname === '/dom_subtree') {
        if (!tryBucket(res, req, reqId, domSubtreeBucket)) return
        applyCorsHeaders(res, req)
        await handleBrowserToolPost(req, res, opts.ctx, 'getDomSubtree')
        return
      }
      if (method === 'POST' && pathname === '/shutdown') {
        // /shutdown is exempt from per-route rate-limit buckets (operator-only, infrequent).
        applyCorsHeaders(res, req)
        await handleShutdownPost(req, res, opts.ctx)
        return
      }

      // /__redesigner/debug/state — env-gated debug snapshot
      if (method === 'GET' && pathname === '/__redesigner/debug/state') {
        if (!debugEnabled) {
          sendProblem(
            res,
            problem(404, 'NotFound', `no route for ${method} ${pathname}`, reqId),
            req,
          )
          return
        }
        if (!tryBucket(res, req, reqId, getBucket)) return
        handleDebugStateGet(req, res, opts.ctx)
        return
      }

      // Known path + wrong method → 405. Otherwise 404.
      if (isKnownPath(pathname)) {
        res.setHeader('Allow', allowedMethodsFor(pathname))
        sendProblem(
          res,
          problem(405, 'MethodNotAllowed', `method ${method} not allowed for ${pathname}`, reqId),
          req,
        )
        return
      }
      sendProblem(res, problem(404, 'NotFound', `no route for ${method} ${pathname}`, reqId), req)
    } catch (err: unknown) {
      // Handlers swallow their own readJsonBody errors already; anything reaching here is
      // genuinely unexpected. Log and 500.
      opts.ctx.logger.error('[server] unhandled route error', {
        err: (err as Error)?.message ?? String(err),
        reqId,
      })
      if (!res.headersSent) {
        sendProblem(res, problem(500, 'InternalError', undefined, reqId), req)
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

function tryBucket(
  res: ServerResponse,
  req: IncomingMessage,
  reqId: string,
  bucket: TokenBucket,
): boolean {
  if (bucket.tryConsume()) return true
  send429(res, req, reqId, bucket)
  return false
}

function send429(
  res: ServerResponse,
  req: IncomingMessage,
  reqId: string,
  bucket: TokenBucket,
): void {
  res.setHeader('Retry-After', String(bucket.retryAfterSec()))
  sendProblem(res, problem(429, 'TooManyRequests', undefined, reqId), req)
}

function isKnownPath(pathname: string): boolean {
  return (
    pathname === '/health' ||
    pathname === '/selection' ||
    pathname === '/selection/recent' ||
    pathname === '/manifest' ||
    pathname === '/computed_styles' ||
    pathname === '/dom_subtree' ||
    pathname === '/shutdown' ||
    pathname === '/__redesigner/exchange' ||
    pathname === '/__redesigner/revalidate'
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
    case '/__redesigner/exchange':
    case '/__redesigner/revalidate':
      return 'POST'
    default:
      return ''
  }
}
