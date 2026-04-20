// @vitest-environment happy-dom
/**
 * Integration tests for packages/ext/src/content/handshake.ts and
 * packages/ext/src/content/index.ts.
 *
 * Covers spec §4.1 steps 2-4:
 *  - Fetch /__redesigner/handshake.json with credentials:'omit'
 *  - X-Redesigner-Bootstrap header preferred; body.bootstrapToken as fallback
 *  - MutationObserver on document.head catches late meta injection
 *  - beforeunload disconnects the observer
 *  - meta-in-body case logs dormantReason
 *  - Forwards {wsUrl,httpUrl,bootstrapToken,editor,clientId} to SW via runtime.sendMessage
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchHandshake, readMetaHandshake } from '../../src/content/handshake.js'
import { makeChromeMock } from '../chromeMock/index.js'

const VALID_WS_URL = 'ws://127.0.0.1:5555/events'
const VALID_HTTP_URL = 'http://127.0.0.1:5555'
const VALID_EDITOR = 'vscode'
const HEADER_TOKEN = 'HEADERTOK'
const BODY_TOKEN = 'BODYTOK'

function makeHandshakeBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    wsUrl: VALID_WS_URL,
    httpUrl: VALID_HTTP_URL,
    bootstrapToken: BODY_TOKEN,
    editor: VALID_EDITOR,
    pluginVersion: '0.0.0',
    daemonVersion: null,
    ...overrides,
  }
}

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}): void {
  const responseHeaders = new Headers(headers)
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      headers: responseHeaders,
      json: () => Promise.resolve(body),
    }),
  )
}

describe('fetchHandshake', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('(1) prefers X-Redesigner-Bootstrap header over body.bootstrapToken', async () => {
    mockFetch(200, makeHandshakeBody({ bootstrapToken: BODY_TOKEN }), {
      'X-Redesigner-Bootstrap': HEADER_TOKEN,
    })
    const result = await fetchHandshake(VALID_HTTP_URL)
    expect(result).not.toBeNull()
    expect(result?.bootstrapToken).toBe(HEADER_TOKEN)
  })

  it('(2) falls back to body.bootstrapToken when header is absent', async () => {
    mockFetch(200, makeHandshakeBody({ bootstrapToken: BODY_TOKEN }))
    const result = await fetchHandshake(VALID_HTTP_URL)
    expect(result).not.toBeNull()
    expect(result?.bootstrapToken).toBe(BODY_TOKEN)
  })

  it('(3) sends fetch with credentials:omit and cache:no-store', async () => {
    mockFetch(200, makeHandshakeBody())
    await fetchHandshake(VALID_HTTP_URL)
    const fetchMock = vi.mocked(globalThis.fetch)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${VALID_HTTP_URL}/__redesigner/handshake.json`)
    expect(opts.credentials).toBe('omit')
    expect(opts.cache).toBe('no-store')
  })

  it('(4) returns null on 4xx response', async () => {
    mockFetch(404, { error: 'not found' })
    const result = await fetchHandshake(VALID_HTTP_URL)
    expect(result).toBeNull()
  })

  it('(5) returns null on schema-invalid body (bad editor)', async () => {
    mockFetch(200, makeHandshakeBody({ editor: 'notepad', bootstrapToken: '' }))
    const result = await fetchHandshake(VALID_HTTP_URL)
    expect(result).toBeNull()
  })

  it('(6) returns null on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network error')))
    const result = await fetchHandshake(VALID_HTTP_URL)
    expect(result).toBeNull()
  })

  it('(7) wsUrl and httpUrl and editor come from body, bootstrapToken from header', async () => {
    mockFetch(
      200,
      makeHandshakeBody({ wsUrl: VALID_WS_URL, httpUrl: VALID_HTTP_URL, editor: 'cursor' }),
      {
        'X-Redesigner-Bootstrap': HEADER_TOKEN,
      },
    )
    const result = await fetchHandshake(VALID_HTTP_URL)
    expect(result).not.toBeNull()
    expect(result?.wsUrl).toBe(VALID_WS_URL)
    expect(result?.httpUrl).toBe(VALID_HTTP_URL)
    expect(result?.editor).toBe('cursor')
    expect(result?.bootstrapToken).toBe(HEADER_TOKEN)
  })
})

describe('readMetaHandshake', () => {
  it('reads wsUrl, httpUrl, bootstrapToken, editor from meta tag', () => {
    const doc = new DOMParser().parseFromString(
      `<html><head><meta name="redesigner-daemon" content='{"wsUrl":"${VALID_WS_URL}","httpUrl":"${VALID_HTTP_URL}","bootstrapToken":"METATOKEN","editor":"vscode","pluginVersion":"0.0.0","daemonVersion":null}'></head></html>`,
      'text/html',
    )
    const result = readMetaHandshake(doc)
    expect(result).not.toBeNull()
    expect(result?.wsUrl).toBe(VALID_WS_URL)
    expect(result?.httpUrl).toBe(VALID_HTTP_URL)
    expect(result?.bootstrapToken).toBe('METATOKEN')
    expect(result?.editor).toBe('vscode')
  })

  it('returns null when meta tag is absent', () => {
    const doc = new DOMParser().parseFromString('<html><head></head></html>', 'text/html')
    const result = readMetaHandshake(doc)
    expect(result).toBeNull()
  })

  it('returns null on malformed JSON in meta content', () => {
    const doc = new DOMParser().parseFromString(
      '<html><head><meta name="redesigner-daemon" content="not-json"></head></html>',
      'text/html',
    )
    const result = readMetaHandshake(doc)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Index integration tests — these test the runContentScript() entry point
// ---------------------------------------------------------------------------

describe('content/index integration', () => {
  let chromeMock: ReturnType<typeof makeChromeMock>
  let originalChrome: typeof globalThis.chrome
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    chromeMock = makeChromeMock()
    originalChrome = globalThis.chrome
    // @ts-expect-error -- assign mock chrome in test environment
    globalThis.chrome = chromeMock
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    globalThis.chrome = originalChrome
    vi.restoreAllMocks()
    // Clean up any injected metas
    for (const el of document.querySelectorAll('meta[name="redesigner-daemon"]')) el.remove()
  })

  async function loadContentScript(): Promise<void> {
    // Fresh import each test via dynamic import with cache-busting is tricky in vitest.
    // Instead, we import and call runContentScript() directly.
    const mod = await import('../../src/content/index.js')
    if ('runContentScript' in mod && typeof mod.runContentScript === 'function') {
      await mod.runContentScript()
    }
  }

  it('(7) register envelope has correct shape with UUID clientId', async () => {
    // Put meta in head
    const meta = document.createElement('meta')
    meta.name = 'redesigner-daemon'
    meta.content = JSON.stringify({
      wsUrl: VALID_WS_URL,
      httpUrl: VALID_HTTP_URL,
      bootstrapToken: 'METATOKEN',
      editor: VALID_EDITOR,
      pluginVersion: '0.0.0',
      daemonVersion: null,
    })
    document.head.appendChild(meta)

    mockFetch(200, makeHandshakeBody({ bootstrapToken: BODY_TOKEN }), {
      'X-Redesigner-Bootstrap': HEADER_TOKEN,
    })

    await loadContentScript()

    const effects = chromeMock._recorder.snapshot()
    const registerEffect = effects.find((e) => e.type === 'runtime.sendMessage')
    expect(registerEffect).toBeDefined()
    const msg = registerEffect?.args as Record<string, unknown>
    expect(msg.type).toBe('register')
    expect(msg.wsUrl).toBe(VALID_WS_URL)
    expect(msg.httpUrl).toBe(VALID_HTTP_URL)
    expect(msg.bootstrapToken).toBe(HEADER_TOKEN)
    expect(msg.editor).toBe(VALID_EDITOR)
    expect(typeof msg.clientId).toBe('string')
    // UUID v4 pattern
    expect(msg.clientId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    // tabId and windowId must NOT be sent by CS (SW injects from sender)
    expect('tabId' in msg).toBe(false)
    expect('windowId' in msg).toBe(false)
  })

  it('(6) meta-in-body logs dormantReason meta-in-body', async () => {
    // Remove any head meta
    for (const el of document.querySelectorAll('meta[name="redesigner-daemon"]')) el.remove()

    // Put meta in body, not head
    const meta = document.createElement('meta')
    meta.name = 'redesigner-daemon'
    meta.content = JSON.stringify({
      wsUrl: VALID_WS_URL,
      httpUrl: VALID_HTTP_URL,
      bootstrapToken: 'BODYMETA',
      editor: VALID_EDITOR,
      pluginVersion: '0.0.0',
      daemonVersion: null,
    })
    document.body.appendChild(meta)

    mockFetch(200, makeHandshakeBody())

    await loadContentScript()

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('meta in <body>'),
      expect.objectContaining({ dormantReason: 'meta-in-body' }),
    )
  })

  it('(5) beforeunload disconnects the MutationObserver', async () => {
    const meta = document.createElement('meta')
    meta.name = 'redesigner-daemon'
    meta.content = JSON.stringify({
      wsUrl: VALID_WS_URL,
      httpUrl: VALID_HTTP_URL,
      bootstrapToken: 'METATOKEN',
      editor: VALID_EDITOR,
      pluginVersion: '0.0.0',
      daemonVersion: null,
    })
    document.head.appendChild(meta)

    mockFetch(200, makeHandshakeBody())

    const disconnectSpy = vi.fn()
    const OriginalMutationObserver = globalThis.MutationObserver
    class MockMO {
      disconnect = disconnectSpy
      observe = vi.fn()
      takeRecords = vi.fn(() => [])
    }
    globalThis.MutationObserver = MockMO as unknown as typeof MutationObserver

    await loadContentScript()

    // Fire beforeunload
    window.dispatchEvent(new Event('beforeunload'))

    expect(disconnectSpy).toHaveBeenCalledOnce()

    globalThis.MutationObserver = OriginalMutationObserver
  })

  it('(4) MutationObserver re-sends register when meta content changes', async () => {
    // Start with no meta
    for (const el of document.querySelectorAll('meta[name="redesigner-daemon"]')) el.remove()

    mockFetch(200, makeHandshakeBody({ bootstrapToken: BODY_TOKEN }))

    await loadContentScript()
    chromeMock._recorder.clear()

    mockFetch(200, makeHandshakeBody({ bootstrapToken: 'NEWTOKEN' }))

    // Inject meta into head to trigger the observer
    const meta = document.createElement('meta')
    meta.name = 'redesigner-daemon'
    meta.content = JSON.stringify({
      wsUrl: VALID_WS_URL,
      httpUrl: VALID_HTTP_URL,
      bootstrapToken: 'METATOKEN2',
      editor: VALID_EDITOR,
      pluginVersion: '0.0.0',
      daemonVersion: null,
    })
    document.head.appendChild(meta)

    // MutationObserver callbacks are microtask-scheduled; wait a tick
    await new Promise((r) => setTimeout(r, 0))

    const effects = chromeMock._recorder.snapshot()
    const registerEffect = effects.find((e) => e.type === 'runtime.sendMessage')
    expect(registerEffect).toBeDefined()
  })

  it('(8) iframe no-op: no fetch and no sendMessage when window.top !== window', async () => {
    // Simulate iframe by making window.top !== window
    const originalTop = Object.getOwnPropertyDescriptor(window, 'top')
    Object.defineProperty(window, 'top', {
      get: () => ({ _fake: true }),
      configurable: true,
    })

    vi.stubGlobal('fetch', vi.fn())

    try {
      await loadContentScript()
      const effects = chromeMock._recorder.snapshot()
      expect(effects.filter((e) => e.type === 'runtime.sendMessage')).toHaveLength(0)
      expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled()
    } finally {
      if (originalTop) {
        Object.defineProperty(window, 'top', originalTop)
      }
    }
  })
})
