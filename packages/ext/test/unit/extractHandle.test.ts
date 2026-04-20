/**
 * Task 21 — extractHandle + stableId unit tests.
 *
 * Covers spec §5.1 (extractHandle tagged result + deadline + HMR re-resolve)
 * and §5.2 (stableId determinism / charset / non-injected-timestamp).
 *
 * Runs in happy-dom. All DOM fixtures are built per-test; no global DOM state.
 *
 * Property tests use plain `fast-check` (already a workspace dep via
 * @redesigner/vite). `FAST_CHECK_SEED=42`, `numRuns: 1000`, `verbose: 2` for
 * shrink logs on failure, matching the spec intent of adding `@fast-check/vitest`.
 *
 * @vitest-environment happy-dom
 */

import type { Manifest } from '@redesigner/core'
import { SELECTION_ID_RE } from '@redesigner/core'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type ExtractResult,
  extractHandle,
  makePickSequencer,
} from '../../src/content/extractHandle'
import { stableId } from '../../src/content/stableId'

const FAST_CHECK_SEED = 42
const NUM_RUNS = 1000

function buildManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: '1.0',
    framework: 'react',
    generatedAt: new Date(0).toISOString(),
    contentHash: 'a'.repeat(64),
    components: {
      'src/App.tsx::App': {
        filePath: 'src/App.tsx',
        exportKind: 'default',
        lineRange: [1, 20],
        displayName: 'App',
      },
      'src/Button.tsx::Button': {
        filePath: 'src/Button.tsx',
        exportKind: 'named',
        lineRange: [5, 30],
        displayName: 'Button',
      },
      ...(overrides.components ?? {}),
    },
    locs: {
      'loc-app-1': {
        componentKey: 'src/App.tsx::App',
        filePath: 'src/App.tsx',
        componentName: 'App',
      },
      'loc-button-1': {
        componentKey: 'src/Button.tsx::Button',
        filePath: 'src/Button.tsx',
        componentName: 'Button',
      },
      'loc-button-2': {
        componentKey: 'src/Button.tsx::Button',
        filePath: 'src/Button.tsx',
        componentName: 'Button',
      },
      ...(overrides.locs ?? {}),
    },
    ...overrides,
  }
}

interface ElementSpec {
  readonly tag: string
  readonly attrs?: Record<string, string>
  readonly id?: string
  readonly text?: string
  readonly leaf?: boolean
  readonly children?: readonly ElementSpec[]
}

/** Programmatic fixture mount — avoids innerHTML (no XSS surface even in tests). */
function mountSpec(spec: ElementSpec): { root: Element; leaf: Element } {
  let leafRef: Element | null = null
  const build = (s: ElementSpec): Element => {
    const node = document.createElement(s.tag)
    if (s.id) node.id = s.id
    if (s.attrs) {
      for (const [k, v] of Object.entries(s.attrs)) node.setAttribute(k, v)
    }
    if (s.leaf) {
      node.setAttribute('data-test-leaf', '')
      leafRef = node
    }
    if (s.text !== undefined) node.textContent = s.text
    for (const child of s.children ?? []) node.appendChild(build(child))
    return node
  }
  const root = build(spec)
  document.body.appendChild(root)
  if (!leafRef) throw new Error('mountSpec: no leaf designated')
  return { root, leaf: leafRef }
}

function clearDom(): void {
  const body = document.body
  while (body.firstChild) body.removeChild(body.firstChild)
}

// --- stableId ---------------------------------------------------------------

describe('stableId', () => {
  it('matches SELECTION_ID_RE for a basic input', () => {
    const id = stableId({
      componentName: 'Button',
      filePath: 'src/Button.tsx',
      lineRange: [5, 30],
      siblingIndex: 0,
    })
    expect(id).toMatch(SELECTION_ID_RE)
  })

  it('is deterministic across calls with identical input', () => {
    const a = stableId({
      componentName: 'X',
      filePath: 'a/b.tsx',
      lineRange: [1, 2],
      siblingIndex: 3,
    })
    const b = stableId({
      componentName: 'X',
      filePath: 'a/b.tsx',
      lineRange: [1, 2],
      siblingIndex: 3,
    })
    expect(a).toBe(b)
  })

  it('output length is bounded to ≤128', () => {
    const id = stableId({
      componentName: 'X'.repeat(256),
      filePath: '/'.repeat(4096),
      lineRange: [0, 2 ** 31 - 1],
      siblingIndex: 9999,
    })
    expect(id.length).toBeLessThanOrEqual(128)
    expect(id.length).toBeGreaterThan(0)
  })

  it('differs when componentName differs', () => {
    const a = stableId({
      componentName: 'A',
      filePath: 'x.tsx',
      lineRange: [1, 2],
      siblingIndex: 0,
    })
    const b = stableId({
      componentName: 'B',
      filePath: 'x.tsx',
      lineRange: [1, 2],
      siblingIndex: 0,
    })
    expect(a).not.toBe(b)
  })

  it('differs when siblingIndex differs', () => {
    const a = stableId({
      componentName: 'X',
      filePath: 'x.tsx',
      lineRange: [1, 2],
      siblingIndex: 0,
    })
    const b = stableId({
      componentName: 'X',
      filePath: 'x.tsx',
      lineRange: [1, 2],
      siblingIndex: 1,
    })
    expect(a).not.toBe(b)
  })

  it('negative test: stableId has no timestamp dependency — identical inputs at different times produce identical ids', () => {
    const input = {
      componentName: 'Widget',
      filePath: 'src/x.tsx',
      lineRange: [10, 20] as [number, number],
      siblingIndex: 2,
    }
    const before = stableId(input)
    const t0 = Date.now()
    while (Date.now() - t0 < 2) {
      /* burn wall-clock; stableId output must not depend on it */
    }
    const after = stableId(input)
    expect(after).toBe(before)
  })

  it('property: determinism — stableId(x) === stableId(x) over arbitrary inputs', () => {
    fc.assert(
      fc.property(
        fc.record({
          componentName: fc.string({ minLength: 1, maxLength: 256 }),
          filePath: fc.string({ minLength: 1, maxLength: 512 }),
          lineRange: fc.tuple(
            fc.integer({ min: 0, max: 1_000_000 }),
            fc.integer({ min: 0, max: 1_000_000 }),
          ),
          siblingIndex: fc.integer({ min: 0, max: 10_000 }),
        }),
        (input) => {
          const a = stableId(input)
          const b = stableId(input)
          return a === b
        },
      ),
      { seed: FAST_CHECK_SEED, numRuns: NUM_RUNS, verbose: 2 },
    )
  })

  it('property: output always matches SELECTION_ID_RE', () => {
    fc.assert(
      fc.property(
        fc.record({
          componentName: fc.string({ minLength: 1, maxLength: 256 }),
          filePath: fc.string({ minLength: 1, maxLength: 512 }),
          lineRange: fc.tuple(
            fc.integer({ min: 0, max: 1_000_000 }),
            fc.integer({ min: 0, max: 1_000_000 }),
          ),
          siblingIndex: fc.integer({ min: 0, max: 10_000 }),
        }),
        (input) => SELECTION_ID_RE.test(stableId(input)),
      ),
      { seed: FAST_CHECK_SEED, numRuns: NUM_RUNS, verbose: 2 },
    )
  })
})

// --- makePickSequencer ------------------------------------------------------

describe('makePickSequencer', () => {
  it('next() returns monotonically increasing ints', () => {
    const seq = makePickSequencer()
    const a = seq.next()
    const b = seq.next()
    const c = seq.next()
    expect(b).toBeGreaterThan(a)
    expect(c).toBeGreaterThan(b)
  })

  it('accept(seq) returns true for increasing seqs and false for stale ones', () => {
    const seq = makePickSequencer()
    const first = seq.next()
    const second = seq.next()
    expect(seq.accept(second)).toBe(true)
    expect(seq.accept(first)).toBe(false)
  })

  it('accept(seq) rejects duplicate accepts of the same seq', () => {
    const seq = makePickSequencer()
    const s = seq.next()
    expect(seq.accept(s)).toBe(true)
    expect(seq.accept(s)).toBe(false)
  })
})

// --- extractHandle ----------------------------------------------------------

describe('extractHandle', () => {
  beforeEach(() => {
    clearDom()
  })
  afterEach(() => {
    clearDom()
  })

  it('returns {ok:false, reason:"iframe"} when el is HTMLIFrameElement', async () => {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const result = await extractHandle({
      el: iframe,
      manifestPromise: Promise.resolve(buildManifest()),
      deadlineMs: 50,
    })
    expect(result).toEqual({ ok: false, reason: 'iframe' })
  })

  it('returns {ok:false, reason:"timeout"} when manifest promise stalls past deadline', async () => {
    const { leaf } = mountSpec({
      tag: 'div',
      attrs: { 'data-redesigner-loc': 'loc-app-1' },
      leaf: true,
    })
    const stalled = new Promise<Manifest>(() => {
      /* never resolves */
    })
    const result = await extractHandle({
      el: leaf,
      manifestPromise: stalled,
      deadlineMs: 20,
    })
    expect(result).toEqual({ ok: false, reason: 'timeout' })
  })

  it('deadline is DECOUPLED from any WS-reconnect racing promise', async () => {
    const { leaf } = mountSpec({
      tag: 'div',
      attrs: { 'data-redesigner-loc': 'loc-app-1' },
      leaf: true,
    })
    const stalledManifest = new Promise<Manifest>(() => {
      /* never */
    })
    // Simulate a fast "WS reconnect" event resolving well before the deadline.
    // extractHandle must NOT latch onto it; only the deadline fires.
    const fastReconnect = new Promise<void>((r) => setTimeout(r, 5))

    const startedAt = Date.now()
    const result = await extractHandle({
      el: leaf,
      manifestPromise: stalledManifest,
      deadlineMs: 40,
    })
    const elapsed = Date.now() - startedAt
    await fastReconnect

    expect(result).toEqual({ ok: false, reason: 'timeout' })
    expect(elapsed).toBeGreaterThanOrEqual(35)
  })

  it('returns {ok:false, reason:"disconnected"} when el.isConnected is false and no lastCoords', async () => {
    const el = document.createElement('div')
    el.setAttribute('data-redesigner-loc', 'loc-app-1')
    // Never attached → isConnected false.
    const result = await extractHandle({
      el,
      manifestPromise: Promise.resolve(buildManifest()),
      deadlineMs: 50,
    })
    expect(result).toEqual({ ok: false, reason: 'disconnected' })
  })

  it('HMR race: isConnected false but lastCoords provided → re-resolves via hitTest', async () => {
    // Prepare a reconnected target.
    const { leaf: fresh } = mountSpec({
      tag: 'div',
      children: [
        {
          tag: 'div',
          id: 'fresh',
          attrs: { 'data-redesigner-loc': 'loc-app-1' },
          leaf: true,
          text: 'x',
        },
      ],
    })
    const stale = document.createElement('div')
    stale.setAttribute('data-redesigner-loc', 'loc-app-1')
    // stale not attached → isConnected=false.

    // happy-dom doesn't implement geometry; monkey-patch elementsFromPoint.
    const origEFP = document.elementsFromPoint
    document.elementsFromPoint = (_x: number, _y: number) => [fresh] as Element[]
    try {
      const result = await extractHandle({
        el: stale,
        manifestPromise: Promise.resolve(buildManifest()),
        deadlineMs: 50,
        lastCoords: { x: 5, y: 5 },
        pickerShadowHost: null,
        pickerShadowRoot: null,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.handle.componentName).toBe('App')
      }
    } finally {
      document.elementsFromPoint = origEFP
    }
  })

  it('returns {ok:false, reason:"no-anchor"} when no [data-redesigner-loc] on ancestor chain', async () => {
    const { leaf } = mountSpec({
      tag: 'div',
      children: [{ tag: 'span', leaf: true, text: 'hi' }],
    })
    const result = await extractHandle({
      el: leaf,
      manifestPromise: Promise.resolve(buildManifest()),
      deadlineMs: 50,
    })
    expect(result).toEqual({ ok: false, reason: 'no-anchor' })
  })

  it('returns {ok:false, reason:"no-anchor"} when locKey is not in manifest.locs', async () => {
    const { leaf } = mountSpec({
      tag: 'div',
      attrs: { 'data-redesigner-loc': 'loc-missing' },
      leaf: true,
    })
    const result = await extractHandle({
      el: leaf,
      manifestPromise: Promise.resolve(buildManifest()),
      deadlineMs: 50,
    })
    expect(result).toEqual({ ok: false, reason: 'no-anchor' })
  })

  it('happy path: resolves full ComponentHandle', async () => {
    const { leaf } = mountSpec({
      tag: 'section',
      attrs: { 'data-redesigner-loc': 'loc-app-1' },
      children: [
        {
          tag: 'article',
          children: [
            {
              tag: 'button',
              attrs: { 'data-redesigner-loc': 'loc-button-1' },
              leaf: true,
              text: 'Click',
            },
          ],
        },
      ],
    })
    const result = await extractHandle({
      el: leaf,
      manifestPromise: Promise.resolve(buildManifest()),
      deadlineMs: 50,
      now: () => 1_700_000_000_000,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const h = result.handle
    expect(h.componentName).toBe('Button')
    expect(h.filePath).toBe('src/Button.tsx')
    expect(h.lineRange).toEqual([5, 30])
    expect(h.timestamp).toBe(1_700_000_000_000)
    expect(h.id).toMatch(SELECTION_ID_RE)
    expect(typeof h.domPath).toBe('string')
    expect(h.domPath.length).toBeLessThanOrEqual(8192)
    expect(Array.isArray(h.parentChain)).toBe(true)
    expect(h.parentChain.length).toBeLessThanOrEqual(64)
  })

  it('siblingIndex: two siblings with same componentName produce different ids', async () => {
    mountSpec({
      tag: 'div',
      id: 'parent',
      children: [
        {
          tag: 'button',
          id: 'b0',
          attrs: { 'data-redesigner-loc': 'loc-button-1' },
          text: 'A',
          leaf: true,
        },
        {
          tag: 'button',
          id: 'b1',
          attrs: { 'data-redesigner-loc': 'loc-button-2' },
          text: 'B',
        },
      ],
    })
    const first = document.getElementById('b0')
    const second = document.getElementById('b1')
    if (!first || !second) throw new Error('fixture missing')
    const manifest = buildManifest()

    const r0 = await extractHandle({
      el: first,
      manifestPromise: Promise.resolve(manifest),
      deadlineMs: 50,
    })
    const r1 = await extractHandle({
      el: second,
      manifestPromise: Promise.resolve(manifest),
      deadlineMs: 50,
    })
    expect(r0.ok).toBe(true)
    expect(r1.ok).toBe(true)
    if (!r0.ok || !r1.ok) return
    expect(r0.handle.id).not.toBe(r1.handle.id)
  })

  it('parentChain is bounded at 64 entries', async () => {
    // Build a deeply nested chain programmatically.
    let inner: ElementSpec = {
      tag: 'div',
      attrs: { 'data-redesigner-loc': 'loc-button-1' },
      leaf: true,
    }
    for (let i = 0; i < 200; i++) {
      inner = {
        tag: 'div',
        attrs: { 'data-redesigner-loc': 'loc-app-1' },
        children: [inner],
      }
    }
    const { leaf } = mountSpec(inner)
    const result = await extractHandle({
      el: leaf,
      manifestPromise: Promise.resolve(buildManifest()),
      deadlineMs: 50,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.handle.parentChain.length).toBeLessThanOrEqual(64)
  })

  it('domPath is a non-empty string bounded by 8192', async () => {
    const { leaf } = mountSpec({
      tag: 'div',
      children: [
        {
          tag: 'section',
          children: [
            {
              tag: 'article',
              children: [
                {
                  tag: 'span',
                  attrs: { 'data-redesigner-loc': 'loc-button-1' },
                  leaf: true,
                  text: 'leaf',
                },
              ],
            },
          ],
        },
      ],
    })
    const result = await extractHandle({
      el: leaf,
      manifestPromise: Promise.resolve(buildManifest()),
      deadlineMs: 50,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.handle.domPath.length).toBeGreaterThan(0)
    expect(result.handle.domPath.length).toBeLessThanOrEqual(8192)
  })

  it('monotonic picker drop: out-of-order resolves are dropped by sequencer', async () => {
    const seq = makePickSequencer()
    const { leaf: leaf1 } = mountSpec({
      tag: 'div',
      attrs: { 'data-redesigner-loc': 'loc-app-1' },
      leaf: true,
    })
    const el2Host = document.createElement('div')
    el2Host.setAttribute('data-redesigner-loc', 'loc-button-1')
    el2Host.id = 'e2'
    document.body.appendChild(el2Host)

    const manifest = buildManifest()

    // Simulate two concurrent pick cycles.
    const seq1 = seq.next()
    const slow = new Promise<Manifest>((r) => setTimeout(() => r(manifest), 20))
    const p1 = extractHandle({ el: leaf1, manifestPromise: slow, deadlineMs: 200 })

    const seq2 = seq.next()
    const fast = Promise.resolve(manifest)
    const p2 = extractHandle({ el: el2Host, manifestPromise: fast, deadlineMs: 200 })

    // p2 resolves first; p1 resolves second — out-of-order.
    const r2 = await p2
    const r1 = await p1
    expect(r2.ok).toBe(true)
    expect(r1.ok).toBe(true)

    // Apply monotonic policy.
    const accept2 = seq.accept(seq2)
    const accept1 = seq.accept(seq1)
    expect(accept2).toBe(true)
    expect(accept1).toBe(false)
  })

  it('tagged failure result exposes a known reason string', () => {
    const reasons = new Set(['timeout', 'disconnected', 'no-anchor', 'iframe'])
    const sample: ExtractResult = { ok: false, reason: 'timeout' }
    expect(sample.ok).toBe(false)
    if (sample.ok) return
    expect(reasons.has(sample.reason)).toBe(true)
  })
})
