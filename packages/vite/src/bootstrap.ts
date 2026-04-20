/**
 * Bootstrap token state + /__redesigner/handshake.json middleware factory.
 *
 * Spec refs:
 *   §2 / §3.2 / §4.2 step 1–2 / §8.8 line 551
 *
 * Gating (per spec line 162):
 *   Host literal-set (localhost:<port>, 127.0.0.1:<port>, [::1]:<port>),
 *   AND `Sec-Fetch-Dest: empty`,
 *   AND `Sec-Fetch-Site ∈ {none, cross-site}`,
 *   AND `Origin` absent OR `chrome-extension://<32 lowercase letters>`.
 *
 * Rejections:
 *   - Method ≠ GET          → 405 + `Allow: GET`             + `method-not-allowed`
 *   - Host not in set       → 421 Misdirected Request         + `host-rejected`
 *   - Fetch-metadata/Origin → 403 Forbidden                   + `host-rejected`
 *     (no dedicated slug; `host-rejected` mirrors the daemon's policy-reject posture)
 *   - Daemon not ready      → 503 Service Unavailable          + `extension-disconnected`
 *
 * Response on 200:
 *   - `X-Redesigner-Bootstrap: <token>` header (CS preferred source)
 *   - `Cache-Control: no-store, private`, `Pragma: no-cache`
 *   - `Vary: Origin, Sec-Fetch-Site, Sec-Fetch-Dest`
 *   - `Content-Type: application/json`
 *   - Body: HandshakeSchema-shaped JSON
 *
 * The token is read from the daemon handoff file on each request via the
 * injected `readBootstrap` reader. When the daemon has not yet started,
 * `current()` returns null and the middleware degrades to 503.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { type Editor, HandshakeSchema } from '@redesigner/core/schemas'

export interface BootstrapState {
  current(): string | null
}

export function createBootstrapState(opts: {
  readBootstrap: () => { bootstrapToken: string } | null
}): BootstrapState {
  return {
    current: () => opts.readBootstrap()?.bootstrapToken ?? null,
  }
}

export interface DaemonInfo {
  port: number
  serverVersion: string
}

export interface HandshakeMiddlewareOptions {
  /** Returns the current Vite dev-server port (read lazily — http.listen is async). */
  viteServerPort: () => number | null
  /** Bootstrap state accessor; `current()` is re-read per request. Returns null when daemon not ready. */
  bootstrap: BootstrapState
  /** Returns daemon `{ port, serverVersion }` if ready, or null if not yet started. */
  getDaemonInfo: () => DaemonInfo | null
  /** Plugin version string (from package.json). */
  pluginVersion: string
  /** Editor enum from user options. */
  editor: Editor
}

export const HANDSHAKE_PATH = '/__redesigner/handshake.json'

// chrome-extension://<32 a-p letters> — matches daemon's CORS allowlist shape.
const CHROME_EXT_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/

function writeNoStoreHeaders(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Vary', 'Origin, Sec-Fetch-Site, Sec-Fetch-Dest')
}

type NextFn = (err?: unknown) => void

export type HandshakeMiddleware = (req: IncomingMessage, res: ServerResponse, next: NextFn) => void

export function createHandshakeMiddleware(opts: HandshakeMiddlewareOptions): HandshakeMiddleware {
  return (req, res, next) => {
    // Path match: accept /__redesigner/handshake.json (with or without a query string).
    // When registered via `server.middlewares.use(HANDSHAKE_PATH, …)` connect already
    // strips the mount path, but we also guard here so the module stays testable in
    // isolation.
    const url = req.url ?? ''
    const pathOnly = url.split('?', 1)[0] ?? ''
    if (pathOnly !== HANDSHAKE_PATH && pathOnly !== '/' && pathOnly !== '') {
      next()
      return
    }

    // Method check — 405 takes precedence over anything else so clients get a clear
    // "wrong verb" signal regardless of Origin / fetch-metadata state.
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET')
      res.setHeader('Content-Type', 'application/problem+json; charset=utf-8')
      writeNoStoreHeaders(res)
      res.end(
        JSON.stringify({
          type: 'https://redesigner.dev/errors/method-not-allowed',
          title: 'MethodNotAllowed',
          status: 405,
          apiErrorCode: 'method-not-allowed',
          detail: `Only GET is allowed on ${HANDSHAKE_PATH}`,
        }),
      )
      return
    }

    // Host gate. Port from Vite's listening address — may be null during very early
    // requests; in that case reject (we cannot verify the authority matches).
    const port = opts.viteServerPort()
    const hostHeader = headerOf(req, 'host')
    if (port === null || !isAllowedHost(hostHeader, port)) {
      writeHostRejected(res, 421, `Host ${hostHeader ?? '(missing)'} not in allowlist`)
      return
    }

    // Fetch-metadata gate.
    const secFetchDest = headerOf(req, 'sec-fetch-dest')
    const secFetchSite = headerOf(req, 'sec-fetch-site')
    if (secFetchDest !== undefined && secFetchDest !== 'empty') {
      writeHostRejected(res, 403, `Sec-Fetch-Dest '${secFetchDest}' not allowed`)
      return
    }
    if (secFetchSite !== undefined && secFetchSite !== 'none' && secFetchSite !== 'cross-site') {
      writeHostRejected(res, 403, `Sec-Fetch-Site '${secFetchSite}' not allowed`)
      return
    }

    // Origin gate: absent is allowed (curl / extension fetch without Origin);
    // otherwise must match chrome-extension://<32 lowercase letters>.
    const origin = headerOf(req, 'origin')
    if (origin !== undefined && !CHROME_EXT_ORIGIN_RE.test(origin)) {
      writeHostRejected(res, 403, `Origin '${origin}' not allowed`)
      return
    }

    // Daemon availability.
    const daemon = opts.getDaemonInfo()
    if (!daemon) {
      res.statusCode = 503
      res.setHeader('Content-Type', 'application/problem+json; charset=utf-8')
      writeNoStoreHeaders(res)
      res.end(
        JSON.stringify({
          type: 'https://redesigner.dev/errors/extension-disconnected',
          title: 'ExtensionDisconnected',
          status: 503,
          apiErrorCode: 'extension-disconnected',
          detail: 'Daemon not started; retry shortly',
        }),
      )
      return
    }

    // Success: emit headers + body. Body values are validated through the schema
    // to prevent drift between the plugin and core's HandshakeSchema.
    const token = opts.bootstrap.current()
    if (token === null) {
      res.statusCode = 503
      res.setHeader('Content-Type', 'application/problem+json; charset=utf-8')
      writeNoStoreHeaders(res)
      res.end(
        JSON.stringify({
          type: 'https://redesigner.dev/errors/extension-disconnected',
          title: 'ExtensionDisconnected',
          status: 503,
          apiErrorCode: 'extension-disconnected',
          detail: 'Daemon not started; retry shortly',
        }),
      )
      return
    }
    let body: ReturnType<typeof HandshakeSchema.parse>
    try {
      body = HandshakeSchema.parse({
        wsUrl: `ws://127.0.0.1:${daemon.port}/events`,
        httpUrl: `http://127.0.0.1:${daemon.port}`,
        bootstrapToken: token,
        editor: opts.editor,
        pluginVersion: opts.pluginVersion,
        daemonVersion: daemon.serverVersion,
      })
    } catch (err: unknown) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/problem+json; charset=utf-8')
      writeNoStoreHeaders(res)
      res.end(
        JSON.stringify({
          type: 'https://redesigner.dev/errors/internal-error',
          title: 'InternalError',
          status: 500,
          apiErrorCode: 'internal-error',
          detail: err instanceof Error ? err.message : 'HandshakeSchema validation failed',
        }),
      )
      return
    }

    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('X-Redesigner-Bootstrap', token)
    writeNoStoreHeaders(res)
    res.end(JSON.stringify(body))
  }
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  if (Array.isArray(v)) return v[0]
  return v
}

function isAllowedHost(host: string | undefined, port: number): boolean {
  if (typeof host !== 'string') return false
  return host === `localhost:${port}` || host === `127.0.0.1:${port}` || host === `[::1]:${port}`
}

function writeHostRejected(res: ServerResponse, status: number, detail: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/problem+json; charset=utf-8')
  writeNoStoreHeaders(res)
  res.end(
    JSON.stringify({
      type: 'https://redesigner.dev/errors/host-rejected',
      title: 'HostRejected',
      status,
      apiErrorCode: 'host-rejected',
      detail,
    }),
  )
}
