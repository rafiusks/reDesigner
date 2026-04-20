// @vitest-environment happy-dom

/**
 * Task 24 — SW exchange + REST integration tests.
 *
 * Covers:
 *  1. Cold boot exchange sends {clientNonce, bootstrapToken} to /__redesigner/exchange.
 *  2. Exchange response updates state(sessionToken, sessionExp, serverNonce).
 *  3. Cached session short-circuits re-fetch until near-expiry.
 *  4. Refresh fires when sessionExp - now <= refreshLeadMs (default 60s).
 *  5. handleRotated(newBootstrap) invalidates prior session + re-exchanges.
 *  6. verifyServerNonceEcho matches stored serverNonce; mismatch returns false.
 *  7. scheduleCsHandshakeRefetch invokes injected callback (1002-cap-exhaust path).
 *  8. postExchange uses AbortSignal.timeout and wraps timeout errors in DaemonRestError.
 *  9. Non-2xx application/problem+json responses surface DaemonRestError with apiErrorCode.
 * 10. URL construction goes through `new URL(path, httpUrl)` (no string concat).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createExchangeController } from '../../src/sw/exchange.js'
import { DaemonRestError, getHealth, postExchange, putSelection } from '../../src/sw/rest.js'

const HTTP_URL = 'http://127.0.0.1:5555'
const WS_URL = 'ws://127.0.0.1:5555/events'
const BOOTSTRAP = 'btok-abc'

interface FakeResponseInit {
  status?: number
  headers?: Record<string, string>
  body?: unknown
  bodyText?: string
}

function fakeResponse(init: FakeResponseInit = {}): Response {
  const status = init.status ?? 200
  const headers = new Headers(init.headers ?? { 'Content-Type': 'application/json' })
  const bodyText =
    init.bodyText !== undefined
      ? init.bodyText
      : init.body === undefined
        ? ''
        : JSON.stringify(init.body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: () => Promise.resolve(bodyText),
    json: () => Promise.resolve(init.body ?? JSON.parse(bodyText || 'null')),
  } as unknown as Response
}

// -------------------------------------------------------------------------
// REST helpers
// -------------------------------------------------------------------------

describe('sw/rest — postExchange', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends POST to /__redesigner/exchange with clientNonce + bootstrapToken', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      fakeResponse({
        body: {
          sessionToken: 'stok',
          exp: 1_700_000_000,
          serverNonce: 'snonce-val-0123456789',
        },
      }),
    )
    vi.stubGlobal('fetch', fetchSpy)

    const res = await postExchange({
      httpUrl: HTTP_URL,
      clientNonce: 'cn-val-0123456789',
      bootstrapToken: BOOTSTRAP,
    })

    expect(res.sessionToken).toBe('stok')
    expect(res.serverNonce).toBe('snonce-val-0123456789')
    expect(res.exp).toBe(1_700_000_000)

    expect(fetchSpy).toHaveBeenCalledOnce()
    const call = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(call[0]).toBe(`${HTTP_URL}/__redesigner/exchange`)
    const opts = call[1]
    expect(opts.method).toBe('POST')
    expect(opts.credentials).toBe('omit')
    expect(opts.cache).toBe('no-store')
    const headers = opts.headers as Record<string, string>
    expect(headers.Accept).toBe('application/json')
    expect(headers['Content-Type']).toContain('application/json')
    expect('Authorization' in headers).toBe(false)
    expect(opts.body).toBe(
      JSON.stringify({ clientNonce: 'cn-val-0123456789', bootstrapToken: BOOTSTRAP }),
    )
    expect(opts.signal).toBeInstanceOf(AbortSignal)
    expect((opts.signal as AbortSignal).aborted).toBe(false)
  })

  it('surfaces problem+json errors as DaemonRestError with apiErrorCode', async () => {
    const problemBody = {
      type: 'https://redesigner.dev/errors/forbidden',
      title: 'Forbidden',
      status: 403,
      detail: 'extension not trusted for this project',
      apiErrorCode: 'unknown-extension',
      instance: '/req/abc',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        fakeResponse({
          status: 403,
          headers: { 'Content-Type': 'application/problem+json; charset=utf-8' },
          body: problemBody,
        }),
      ),
    )

    await expect(
      postExchange({ httpUrl: HTTP_URL, clientNonce: 'cn', bootstrapToken: BOOTSTRAP }),
    ).rejects.toMatchObject({
      name: 'DaemonRestError',
      status: 403,
      apiErrorCode: 'unknown-extension',
      detail: 'extension not trusted for this project',
    })
  })

  it('wraps AbortError timeouts as DaemonRestError (uses AbortSignal.timeout)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, opts?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = opts?.signal
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new DOMException('The operation was aborted.', 'AbortError')
              reject(err)
            })
          }
        })
      }),
    )

    await expect(
      postExchange({
        httpUrl: HTTP_URL,
        clientNonce: 'cn',
        bootstrapToken: BOOTSTRAP,
        timeoutMs: 10,
      }),
    ).rejects.toBeInstanceOf(DaemonRestError)
  })

  it('rejects non-2xx responses with plain JSON bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fakeResponse({ status: 500, body: { error: 'boom' } })),
    )
    await expect(
      postExchange({ httpUrl: HTTP_URL, clientNonce: 'cn', bootstrapToken: BOOTSTRAP }),
    ).rejects.toMatchObject({
      name: 'DaemonRestError',
      status: 500,
    })
  })

  it('rejects schema-invalid response body with DaemonRestError', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          fakeResponse({ body: { sessionToken: 'stok' /* missing exp + serverNonce */ } }),
        ),
    )
    await expect(
      postExchange({ httpUrl: HTTP_URL, clientNonce: 'cn', bootstrapToken: BOOTSTRAP }),
    ).rejects.toBeInstanceOf(DaemonRestError)
  })
})

describe('sw/rest — getHealth + putSelection', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('getHealth sends Authorization: Bearer <sessionToken> and Accept: application/json', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeResponse({ body: { ok: true } }))
    vi.stubGlobal('fetch', fetchSpy)

    const res = await getHealth({ httpUrl: HTTP_URL, sessionToken: 'stok' })
    expect(res.ok).toBe(true)

    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${HTTP_URL}/__redesigner/health`)
    const headers = opts.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer stok')
    expect(headers.Accept).toBe('application/json')
    expect(opts.credentials).toBe('omit')
  })

  it('putSelection sends PUT to /tabs/{tabId}/selection with bearer + body', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(fakeResponse({ body: { selectionSeq: 1, acceptedAt: 1700_000_000_000 } }))
    vi.stubGlobal('fetch', fetchSpy)

    const body = {
      clientId: '00000000-0000-4000-8000-000000000000',
      nodes: [
        {
          id: 'sel-1',
          componentName: 'App',
          filePath: '/src/App.tsx',
          lineRange: [1, 10] as [number, number],
          domPath: 'html>body>div',
          parentChain: ['App'],
          timestamp: 1700_000_000_000,
        },
      ],
    }
    const res = await putSelection({
      httpUrl: HTTP_URL,
      tabId: 42,
      sessionToken: 'stok',
      body,
    })
    expect(res.selectionSeq).toBe(1)

    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${HTTP_URL}/tabs/42/selection`)
    expect(opts.method).toBe('PUT')
    const headers = opts.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer stok')
    expect(headers['Content-Type']).toContain('application/json')
    expect(opts.body).toBe(JSON.stringify(body))
  })
})

// -------------------------------------------------------------------------
// ExchangeController
// -------------------------------------------------------------------------

function makeRestStub(
  resolver: (n: number) => { sessionToken: string; exp: number; serverNonce: string },
): {
  postExchange: typeof postExchange
  calls: Array<{ clientNonce: string; bootstrapToken: string; httpUrl: string }>
} {
  const calls: Array<{ clientNonce: string; bootstrapToken: string; httpUrl: string }> = []
  let n = 0
  const impl = async (args: {
    httpUrl: string
    clientNonce: string
    bootstrapToken: string
    timeoutMs?: number
  }): Promise<{ sessionToken: string; exp: number; serverNonce: string }> => {
    n += 1
    calls.push({
      clientNonce: args.clientNonce,
      bootstrapToken: args.bootstrapToken,
      httpUrl: args.httpUrl,
    })
    return resolver(n)
  }
  return {
    postExchange: impl as unknown as typeof postExchange,
    calls,
  }
}

describe('sw/exchange — createExchangeController', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('(1) cold boot: ensureSession calls postExchange with fresh clientNonce + bootstrap', async () => {
    const rest = makeRestStub(() => ({
      sessionToken: 'stok1',
      exp: 9_999_999_999_000,
      serverNonce: 'sn1',
    }))
    let nonceCalls = 0
    const ctl = createExchangeController({
      rest,
      generateClientNonce: () => {
        nonceCalls += 1
        return `cn-${nonceCalls}`
      },
      now: () => 1_000_000,
    })
    ctl.setBootstrap({ bootstrapToken: BOOTSTRAP, httpUrl: HTTP_URL, wsUrl: WS_URL })

    const tok = await ctl.ensureSession()
    expect(tok).toBe('stok1')
    expect(rest.calls).toHaveLength(1)
    expect(rest.calls[0]).toEqual({
      clientNonce: 'cn-1',
      bootstrapToken: BOOTSTRAP,
      httpUrl: HTTP_URL,
    })
  })

  it('(2) post-exchange state exposes sessionToken + sessionExp + serverNonce', async () => {
    const rest = makeRestStub(() => ({
      sessionToken: 'stok',
      exp: 2_000_000,
      serverNonce: 'snonce',
    }))
    const ctl = createExchangeController({ rest, now: () => 1_000_000 })
    ctl.setBootstrap({ bootstrapToken: BOOTSTRAP, httpUrl: HTTP_URL, wsUrl: WS_URL })
    await ctl.ensureSession()

    const s = ctl.state()
    expect(s.sessionToken).toBe('stok')
    expect(s.sessionExp).toBe(2_000_000)
    expect(s.serverNonce).toBe('snonce')
    expect(s.bootstrapToken).toBe(BOOTSTRAP)
    expect(s.httpUrl).toBe(HTTP_URL)
    expect(s.wsUrl).toBe(WS_URL)
  })

  it('(3) cached token within exp window: second ensureSession reuses first exchange', async () => {
    const rest = makeRestStub(() => ({ sessionToken: 'stok', exp: 5_000_000, serverNonce: 'sn' }))
    const ctl = createExchangeController({ rest, now: () => 1_000_000 })
    ctl.setBootstrap({ bootstrapToken: BOOTSTRAP, httpUrl: HTTP_URL, wsUrl: WS_URL })

    const t1 = await ctl.ensureSession()
    const t2 = await ctl.ensureSession()
    expect(t1).toBe(t2)
    expect(rest.calls).toHaveLength(1)
  })

  it('(4) refresh ~60s before exp: near-exp triggers fresh exchange', async () => {
    let mintedN = 0
    const rest = makeRestStub(() => {
      mintedN += 1
      return {
        sessionToken: `stok-${mintedN}`,
        exp: 1_000_000 + mintedN * 120_000,
        serverNonce: `sn-${mintedN}`,
      }
    })
    let currentNow = 1_000_000
    const ctl = createExchangeController({
      rest,
      now: () => currentNow,
      refreshLeadMs: 60_000,
    })
    ctl.setBootstrap({ bootstrapToken: BOOTSTRAP, httpUrl: HTTP_URL, wsUrl: WS_URL })

    const t1 = await ctl.ensureSession()
    expect(t1).toBe('stok-1')
    expect(rest.calls).toHaveLength(1)

    // Jump forward so now + 60_000 > sessionExp (1_120_000). now=1_070_000 means
    // exp - now = 50_000ms < refreshLeadMs → refresh.
    currentNow = 1_070_000
    const t2 = await ctl.ensureSession()
    expect(t2).toBe('stok-2')
    expect(rest.calls).toHaveLength(2)
  })

  it('(5) handleRotated invalidates prior session and re-exchanges with new bootstrap', async () => {
    let mintedN = 0
    const rest = makeRestStub(() => {
      mintedN += 1
      return {
        sessionToken: `stok-${mintedN}`,
        exp: 9_999_999_999_000,
        serverNonce: `sn-${mintedN}`,
      }
    })
    const ctl = createExchangeController({ rest, now: () => 1_000_000 })
    ctl.setBootstrap({ bootstrapToken: BOOTSTRAP, httpUrl: HTTP_URL, wsUrl: WS_URL })

    const t1 = await ctl.ensureSession()
    expect(t1).toBe('stok-1')

    await ctl.handleRotated('btok-rotated')

    expect(rest.calls).toHaveLength(2)
    expect(rest.calls[1]?.bootstrapToken).toBe('btok-rotated')
    const s = ctl.state()
    expect(s.sessionToken).toBe('stok-2')
    expect(s.serverNonce).toBe('sn-2')
    expect(s.bootstrapToken).toBe('btok-rotated')
  })

  it('(6) verifyServerNonceEcho matches stored nonce; mismatch returns false', async () => {
    const rest = makeRestStub(() => ({ sessionToken: 's', exp: 9e12, serverNonce: 'the-nonce' }))
    const ctl = createExchangeController({ rest, now: () => 1_000_000 })
    ctl.setBootstrap({ bootstrapToken: BOOTSTRAP, httpUrl: HTTP_URL, wsUrl: WS_URL })
    await ctl.ensureSession()

    expect(ctl.verifyServerNonceEcho({ serverNonceEcho: 'the-nonce' })).toBe(true)
    expect(ctl.verifyServerNonceEcho({ serverNonceEcho: 'wrong' })).toBe(false)
    expect(ctl.verifyServerNonceEcho({})).toBe(false)
    expect(ctl.verifyServerNonceEcho({ serverNonceEcho: null })).toBe(false)
  })

  it('(7) scheduleCsHandshakeRefetch invokes injected callback', () => {
    const rest = makeRestStub(() => ({ sessionToken: 's', exp: 1, serverNonce: 'n' }))
    const cb = vi.fn()
    const ctl = createExchangeController({ rest, onCsHandshakeRefetch: cb })
    ctl.scheduleCsHandshakeRefetch()
    expect(cb).toHaveBeenCalledOnce()
  })

  it('(8) invalidateSession clears sessionToken/Exp/serverNonce', async () => {
    const rest = makeRestStub(() => ({ sessionToken: 'stok', exp: 9e12, serverNonce: 'sn' }))
    const ctl = createExchangeController({ rest, now: () => 1_000_000 })
    ctl.setBootstrap({ bootstrapToken: BOOTSTRAP, httpUrl: HTTP_URL, wsUrl: WS_URL })
    await ctl.ensureSession()
    expect(ctl.state().sessionToken).toBe('stok')

    ctl.invalidateSession()
    const s = ctl.state()
    expect(s.sessionToken).toBeNull()
    expect(s.sessionExp).toBeNull()
    expect(s.serverNonce).toBeNull()
  })

  it('(9) persist callback is invoked after successful exchange', async () => {
    const rest = makeRestStub(() => ({ sessionToken: 'stok', exp: 2_000_000, serverNonce: 'sn' }))
    const persist = vi.fn().mockResolvedValue(undefined)
    const ctl = createExchangeController({ rest, persist, now: () => 1_000_000 })
    ctl.setBootstrap({ bootstrapToken: BOOTSTRAP, httpUrl: HTTP_URL, wsUrl: WS_URL })
    await ctl.ensureSession()

    expect(persist).toHaveBeenCalled()
    const last = persist.mock.calls.at(-1)?.[0] as {
      sessionToken: string | null
      sessionExp: number | null
      serverNonce: string | null
    }
    expect(last.sessionToken).toBe('stok')
    expect(last.sessionExp).toBe(2_000_000)
    expect(last.serverNonce).toBe('sn')
  })

  it('(10) ensureSession without setBootstrap throws', async () => {
    const rest = makeRestStub(() => ({ sessionToken: 's', exp: 9e12, serverNonce: 'n' }))
    const ctl = createExchangeController({ rest })
    await expect(ctl.ensureSession()).rejects.toThrow()
  })

  it('(11) ensureSession failure propagates and leaves session unchanged', async () => {
    let n = 0
    const rest = {
      postExchange: (async (args: {
        httpUrl: string
        clientNonce: string
        bootstrapToken: string
      }) => {
        n += 1
        if (n === 1) throw new DaemonRestError(403, 'unknown-extension', 'nope', null)
        return { sessionToken: 'late', exp: 9e12, serverNonce: 'sn' }
      }) as unknown as typeof postExchange,
    }
    const ctl = createExchangeController({ rest, now: () => 1_000_000 })
    ctl.setBootstrap({ bootstrapToken: BOOTSTRAP, httpUrl: HTTP_URL, wsUrl: WS_URL })

    await expect(ctl.ensureSession()).rejects.toBeInstanceOf(DaemonRestError)
    expect(ctl.state().sessionToken).toBeNull()

    const tok = await ctl.ensureSession()
    expect(tok).toBe('late')
  })

  it('(12) clientNonce is fresh on every exchange (one-shot defense-in-depth)', async () => {
    let n = 0
    const rest = makeRestStub(() => {
      n += 1
      return { sessionToken: `s${n}`, exp: 1_000_000 + n, serverNonce: `sn${n}` }
    })
    let counter = 0
    const ctl = createExchangeController({
      rest,
      now: () => 2_000_000,
      generateClientNonce: () => {
        counter += 1
        return `cn-${counter}`
      },
    })
    ctl.setBootstrap({ bootstrapToken: BOOTSTRAP, httpUrl: HTTP_URL, wsUrl: WS_URL })

    await ctl.ensureSession()
    ctl.invalidateSession()
    await ctl.ensureSession()

    expect(rest.calls).toHaveLength(2)
    expect(rest.calls[0]?.clientNonce).not.toBe(rest.calls[1]?.clientNonce)
  })
})
