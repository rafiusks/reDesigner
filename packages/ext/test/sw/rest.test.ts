// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { DaemonRestError, getHealth, postExchange, putSelection } from '../../src/sw/rest.js'

const HTTP_URL = 'http://localhost:9999'

const validHandle = {
  id: 'test-id-1',
  componentName: 'PricingCard',
  filePath: 'src/components/PricingCard.tsx',
  lineRange: [3, 42] as [number, number],
  domPath: 'body > div',
  parentChain: ['App'],
  timestamp: 1_700_000_000_000,
}

function makeSelectionResponse(): Response {
  return new Response(JSON.stringify({ selectionSeq: 1, acceptedAt: Date.now() }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeExchangeResponse(): Response {
  return new Response(
    JSON.stringify({
      sessionToken: 'stok',
      exp: 9_999_999_999_000,
      serverNonce: 'snonce-val-0123456789',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function makeHealthResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Stub fetch and return a ref the test can inspect after the call.
// vi.stubGlobal + afterEach unstub is the codebase convention — don't use raw
// `globalThis.fetch =` because vi.restoreAllMocks() doesn't undo it.
function stubFetchCapture(response: () => Response): { headers: () => Headers | undefined } {
  let captured: Headers | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      captured = new Headers(init?.headers as HeadersInit)
      return response()
    }),
  )
  return { headers: () => captured }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// -------------------------------------------------------------------------
// putSelection — X-Redesigner-Ext-Id header
// -------------------------------------------------------------------------

describe('putSelection X-Redesigner-Ext-Id header', () => {
  test('sends X-Redesigner-Ext-Id when extId is supplied', async () => {
    const cap = stubFetchCapture(makeSelectionResponse)
    await putSelection({
      httpUrl: HTTP_URL,
      tabId: 1,
      sessionToken: 'test-session',
      extId: 'abcdefghijklmnopabcdefghijklmnop',
      body: { nodes: [validHandle] },
    })
    expect(cap.headers()?.get('X-Redesigner-Ext-Id')).toBe('abcdefghijklmnopabcdefghijklmnop')
  })

  test('omits X-Redesigner-Ext-Id when extId is undefined', async () => {
    const cap = stubFetchCapture(makeSelectionResponse)
    await putSelection({
      httpUrl: HTTP_URL,
      tabId: 1,
      sessionToken: 'test-session',
      body: { nodes: [validHandle] },
    })
    expect(cap.headers()?.has('X-Redesigner-Ext-Id')).toBe(false)
  })

  test('honors custom timeoutMs — AbortSignal fires within the timeout window', async () => {
    const startMs = Date.now()
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, init) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined
          if (signal) {
            signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'))
            })
          }
        })
      }),
    )

    await expect(
      putSelection({
        httpUrl: HTTP_URL,
        tabId: 1,
        sessionToken: 'test-session',
        body: { nodes: [validHandle] },
        timeoutMs: 50,
      }),
    ).rejects.toBeInstanceOf(DaemonRestError)

    // 50ms timeout should have aborted well under a 1s ceiling.
    expect(Date.now() - startMs).toBeLessThan(1_000)
  })
})

// -------------------------------------------------------------------------
// postExchange — X-Redesigner-Ext-Id header
// -------------------------------------------------------------------------

describe('postExchange X-Redesigner-Ext-Id header', () => {
  test('sends X-Redesigner-Ext-Id when extId is supplied', async () => {
    const cap = stubFetchCapture(makeExchangeResponse)
    await postExchange({
      httpUrl: HTTP_URL,
      clientNonce: 'cn-val-0123456789',
      bootstrapToken: 'btok-abc',
      extId: 'abcdefghijklmnopabcdefghijklmnop',
    })
    expect(cap.headers()?.get('X-Redesigner-Ext-Id')).toBe('abcdefghijklmnopabcdefghijklmnop')
  })

  test('omits X-Redesigner-Ext-Id when extId is undefined', async () => {
    const cap = stubFetchCapture(makeExchangeResponse)
    await postExchange({
      httpUrl: HTTP_URL,
      clientNonce: 'cn-val-0123456789',
      bootstrapToken: 'btok-abc',
    })
    expect(cap.headers()?.has('X-Redesigner-Ext-Id')).toBe(false)
  })
})

// -------------------------------------------------------------------------
// getHealth — X-Redesigner-Ext-Id header
// -------------------------------------------------------------------------

describe('getHealth X-Redesigner-Ext-Id header', () => {
  test('sends X-Redesigner-Ext-Id when extId is supplied', async () => {
    const cap = stubFetchCapture(makeHealthResponse)
    await getHealth({
      httpUrl: HTTP_URL,
      sessionToken: 'test-session',
      extId: 'abcdefghijklmnopabcdefghijklmnop',
    })
    expect(cap.headers()?.get('X-Redesigner-Ext-Id')).toBe('abcdefghijklmnopabcdefghijklmnop')
  })

  test('omits X-Redesigner-Ext-Id when extId is undefined', async () => {
    const cap = stubFetchCapture(makeHealthResponse)
    await getHealth({
      httpUrl: HTTP_URL,
      sessionToken: 'test-session',
    })
    expect(cap.headers()?.has('X-Redesigner-Ext-Id')).toBe(false)
  })
})
