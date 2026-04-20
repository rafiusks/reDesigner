// @vitest-environment happy-dom

/**
 * SW REST client — extId header plumbing (Slice A).
 *
 * Covers:
 *  1. putSelection sends X-Redesigner-Ext-Id when extId is supplied.
 *  2. putSelection omits X-Redesigner-Ext-Id when extId is undefined.
 *  3. putSelection honors custom timeoutMs (AbortSignal fires within window).
 *  4. postExchange sends X-Redesigner-Ext-Id when extId is supplied.
 *  5. postExchange omits X-Redesigner-Ext-Id when extId is undefined.
 *  6. getHealth sends X-Redesigner-Ext-Id when extId is supplied.
 *  7. getHealth omits X-Redesigner-Ext-Id when extId is undefined.
 */

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

afterEach(() => {
  vi.restoreAllMocks()
})

// -------------------------------------------------------------------------
// putSelection — X-Redesigner-Ext-Id header
// -------------------------------------------------------------------------

describe('putSelection X-Redesigner-Ext-Id header', () => {
  test('sends X-Redesigner-Ext-Id when extId is supplied', async () => {
    let capturedHeaders: Headers | undefined
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedHeaders = new Headers(init?.headers as HeadersInit)
      return makeSelectionResponse()
    })
    await putSelection({
      httpUrl: HTTP_URL,
      tabId: 1,
      sessionToken: 'test-session',
      extId: 'abcdefghijklmnopabcdefghijklmnop',
      body: { nodes: [validHandle] },
    })
    expect(capturedHeaders?.get('X-Redesigner-Ext-Id')).toBe('abcdefghijklmnopabcdefghijklmnop')
  })

  test('omits X-Redesigner-Ext-Id when extId is undefined', async () => {
    let capturedHeaders: Headers | undefined
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedHeaders = new Headers(init?.headers as HeadersInit)
      return makeSelectionResponse()
    })
    await putSelection({
      httpUrl: HTTP_URL,
      tabId: 1,
      sessionToken: 'test-session',
      body: { nodes: [validHandle] },
    })
    expect(capturedHeaders?.has('X-Redesigner-Ext-Id')).toBe(false)
  })

  test('honors custom timeoutMs — AbortSignal fires within the timeout window', async () => {
    const startMs = Date.now()
    globalThis.fetch = vi.fn((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        }
      })
    })

    await expect(
      putSelection({
        httpUrl: HTTP_URL,
        tabId: 1,
        sessionToken: 'test-session',
        body: { nodes: [validHandle] },
        timeoutMs: 50,
      }),
    ).rejects.toBeInstanceOf(DaemonRestError)

    const elapsedMs = Date.now() - startMs
    // Should have aborted well within 1s; the 50ms timeout is the upper bound.
    expect(elapsedMs).toBeLessThan(1_000)
  })
})

// -------------------------------------------------------------------------
// postExchange — X-Redesigner-Ext-Id header
// -------------------------------------------------------------------------

describe('postExchange X-Redesigner-Ext-Id header', () => {
  test('sends X-Redesigner-Ext-Id when extId is supplied', async () => {
    let capturedHeaders: Headers | undefined
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedHeaders = new Headers(init?.headers as HeadersInit)
      return makeExchangeResponse()
    })
    await postExchange({
      httpUrl: HTTP_URL,
      clientNonce: 'cn-val-0123456789',
      bootstrapToken: 'btok-abc',
      extId: 'abcdefghijklmnopabcdefghijklmnop',
    })
    expect(capturedHeaders?.get('X-Redesigner-Ext-Id')).toBe('abcdefghijklmnopabcdefghijklmnop')
  })

  test('omits X-Redesigner-Ext-Id when extId is undefined', async () => {
    let capturedHeaders: Headers | undefined
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedHeaders = new Headers(init?.headers as HeadersInit)
      return makeExchangeResponse()
    })
    await postExchange({
      httpUrl: HTTP_URL,
      clientNonce: 'cn-val-0123456789',
      bootstrapToken: 'btok-abc',
    })
    expect(capturedHeaders?.has('X-Redesigner-Ext-Id')).toBe(false)
  })
})

// -------------------------------------------------------------------------
// getHealth — X-Redesigner-Ext-Id header
// -------------------------------------------------------------------------

describe('getHealth X-Redesigner-Ext-Id header', () => {
  test('sends X-Redesigner-Ext-Id when extId is supplied', async () => {
    let capturedHeaders: Headers | undefined
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedHeaders = new Headers(init?.headers as HeadersInit)
      return makeHealthResponse()
    })
    await getHealth({
      httpUrl: HTTP_URL,
      sessionToken: 'test-session',
      extId: 'abcdefghijklmnopabcdefghijklmnop',
    })
    expect(capturedHeaders?.get('X-Redesigner-Ext-Id')).toBe('abcdefghijklmnopabcdefghijklmnop')
  })

  test('omits X-Redesigner-Ext-Id when extId is undefined', async () => {
    let capturedHeaders: Headers | undefined
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedHeaders = new Headers(init?.headers as HeadersInit)
      return makeHealthResponse()
    })
    await getHealth({
      httpUrl: HTTP_URL,
      sessionToken: 'test-session',
    })
    expect(capturedHeaders?.has('X-Redesigner-Ext-Id')).toBe(false)
  })
})
