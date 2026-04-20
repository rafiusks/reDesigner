/**
 * extractHandle — spec §5.1.
 *
 * Turns a picked `Element` + manifest into a `ComponentHandle`, or a tagged
 * failure describing why it couldn't. Pure of side effects; no DOM writes.
 *
 * Flow (strict order):
 *   1. Iframe short-circuit — same-origin iframes / cross-origin all return
 *      `{ok:false, reason:'iframe'}` without awaiting the manifest.
 *   2. Await manifest with a hard deadline decoupled from any WS-reconnect
 *      plumbing. We use a fresh `setTimeout`-based sentinel race so a
 *      caller-provided promise resolution elsewhere cannot "steal" the
 *      deadline. (Explicitly avoids AbortSignal.timeout for the same reason
 *      documented in CLAUDE.md: composing signals across caller boundaries
 *      leaks event-target listeners — undici#2198 / node#57736. Here the
 *      manifestPromise isn't ours to cancel, so a racing sentinel is the
 *      right primitive.)
 *   3. If `el.isConnected === false` and the caller provided `lastCoords`,
 *      re-run `hitTest` at those coords — this covers the HMR race where
 *      the manifest await straddles a remount.
 *   4. Walk the ancestor chain (across open shadow roots) for the closest
 *      `[data-redesigner-loc]` — spec §5.1 anchor.
 *   5. Look up `locKey` in `manifest.locs` and `componentKey` in
 *      `manifest.components`.
 *   6. Compute `siblingIndex` (count of earlier siblings in the anchored
 *      element's parent with the same componentName) and the bounded
 *      `domPath` / `parentChain`.
 *   7. Mint a deterministic `id` via `stableId`.
 *
 * Monotonic pick ordering is the caller's concern; we export
 * `makePickSequencer()` so the picker can drop resolves that land out of
 * order after a later pick has already committed.
 */

import type { ComponentHandle, Manifest } from '@redesigner/core'
import { closestAcrossShadowDom, hitTest } from './hitTest'
import { stableId } from './stableId'

export type ExtractReason = 'timeout' | 'disconnected' | 'no-anchor' | 'iframe'

export interface ExtractFailure {
  readonly ok: false
  readonly reason: ExtractReason
}

export interface ExtractSuccess {
  readonly ok: true
  readonly handle: ComponentHandle
}

export type ExtractResult = ExtractSuccess | ExtractFailure

export interface ExtractArgs {
  readonly el: Element
  readonly manifestPromise: Promise<Manifest>
  readonly deadlineMs?: number
  readonly now?: () => number
  readonly lastCoords?: { readonly x: number; readonly y: number } | null
  readonly pickerShadowHost?: Element | null
  readonly pickerShadowRoot?: ShadowRoot | null
}

const DEFAULT_DEADLINE_MS = 3000
const MAX_PARENT_CHAIN = 64
const MAX_DOM_PATH_LEN = 8192
const DOM_PATH_MAX_DEPTH = 12 // bounded ancestor walk; ">" joined tags.

/** Opaque sentinel for withTimeout — referentially unique. */
const TIMEOUT = Symbol('extractHandle:timeout')

export async function extractHandle(args: ExtractArgs): Promise<ExtractResult> {
  const deadlineMs = args.deadlineMs ?? DEFAULT_DEADLINE_MS
  const nowFn = args.now ?? Date.now

  // 1. Iframe short-circuit. Keep this BEFORE the manifest await so users
  //    picking an <iframe> don't burn the 3s deadline.
  if (args.el instanceof HTMLIFrameElement) {
    return { ok: false, reason: 'iframe' }
  }

  // 2. Await manifest with a racing timeout sentinel.
  const manifest = await withTimeout(args.manifestPromise, deadlineMs)
  if (manifest === TIMEOUT) return { ok: false, reason: 'timeout' }

  // 3. HMR race: if the picked element fell out of the tree while we awaited,
  //    try to re-resolve at the last known pointer coords.
  let el: Element = args.el
  if (!el.isConnected) {
    if (args.lastCoords) {
      const reHit = hitTest({
        x: args.lastCoords.x,
        y: args.lastCoords.y,
        pickerShadowHost: args.pickerShadowHost ?? null,
        pickerShadowRoot: args.pickerShadowRoot ?? null,
      })
      if (reHit?.isConnected) {
        el = reHit
      } else {
        return { ok: false, reason: 'disconnected' }
      }
    } else {
      return { ok: false, reason: 'disconnected' }
    }
  }

  // 4. Anchor: closest [data-redesigner-loc] across open shadows.
  const anchored = closestAcrossShadowDom(el, '[data-redesigner-loc]')
  if (!anchored) return { ok: false, reason: 'no-anchor' }

  // 5. Manifest lookups.
  const locKey = anchored.getAttribute('data-redesigner-loc')
  if (!locKey) return { ok: false, reason: 'no-anchor' }
  const locEntry = manifest.locs[locKey]
  if (!locEntry) return { ok: false, reason: 'no-anchor' }

  const compEntry = manifest.components[locEntry.componentKey]
  // Fall back to locEntry values if the component record is missing (a
  // manifest-level inconsistency); spec prefers components[] lineRange when
  // available, but we don't reject the handle over it.
  const filePath = compEntry?.filePath ?? locEntry.filePath
  const componentName = compEntry?.displayName ?? locEntry.componentName
  const lineRange: [number, number] = compEntry?.lineRange ?? [0, 0]

  // 6. Sibling index among same-component siblings. Spec §5.1: "index among
  //    siblings of same componentName". We count element siblings that also
  //    anchor a [data-redesigner-loc] whose componentName matches.
  const siblingIndex = computeSiblingIndex(anchored, manifest, componentName)
  const domPath = computeDomPath(anchored)
  const parentChain = computeParentChain(anchored, manifest)

  // 7. Deterministic id.
  const id = stableId({ componentName, filePath, lineRange, siblingIndex })

  const handle: ComponentHandle = {
    id,
    componentName,
    filePath,
    lineRange,
    domPath,
    parentChain,
    timestamp: nowFn(),
  }
  return { ok: true, handle }
}

// --- utilities --------------------------------------------------------------

/** Race `p` against a `setTimeout(ms)` sentinel. Decoupled from any external
 *  AbortSignal / reconnect promise so callers can't accidentally steal the
 *  deadline. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  return new Promise<T | typeof TIMEOUT>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(TIMEOUT)
    }, ms)
    p.then(
      (v) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v)
      },
      (_err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // Rejected manifest is treated identically to a timeout: we have no
        // manifest to work with. Re-using the TIMEOUT sentinel keeps the
        // caller's branch count at two.
        resolve(TIMEOUT)
      },
    )
  })
}

function computeSiblingIndex(anchored: Element, manifest: Manifest, componentName: string): number {
  const parent = anchored.parentElement
  if (!parent) return 0
  let idx = 0
  // Walk previous siblings; count those whose [data-redesigner-loc]
  // resolves to the same componentName.
  let cur: Element | null = anchored.previousElementSibling
  while (cur) {
    const loc = cur.getAttribute?.('data-redesigner-loc')
    if (loc) {
      const entry = manifest.locs[loc]
      if (entry && entry.componentName === componentName) idx++
    }
    cur = cur.previousElementSibling
  }
  return idx
}

/** A short tag-path from a bounded set of ancestors, joined with ">". Keeps
 *  the output deterministic, readable for debugging, and bounded by both
 *  depth and length. */
function computeDomPath(anchored: Element): string {
  const tags: string[] = []
  let cur: Element | null = anchored
  let depth = 0
  while (cur && depth < DOM_PATH_MAX_DEPTH) {
    tags.push(cur.tagName.toLowerCase())
    cur = cur.parentElement
    depth++
  }
  tags.reverse()
  let out = tags.join('>')
  if (out.length > MAX_DOM_PATH_LEN) out = out.slice(0, MAX_DOM_PATH_LEN)
  return out
}

/** Component-name chain of ancestors that themselves carry a
 *  [data-redesigner-loc], walking outward. Bounded at 64 entries and each
 *  entry's length capped at 256 to satisfy the schema. */
function computeParentChain(anchored: Element, manifest: Manifest): string[] {
  const out: string[] = []
  let cur: Element | null = anchored.parentElement
  while (cur && out.length < MAX_PARENT_CHAIN) {
    const loc = cur.getAttribute?.('data-redesigner-loc')
    if (loc) {
      const entry = manifest.locs[loc]
      if (entry) {
        const name = entry.componentName
        out.push(name.length > 256 ? name.slice(0, 256) : name)
      }
    }
    cur = cur.parentElement
  }
  return out
}

// --- monotonic pick sequencer ----------------------------------------------

/** Small counter used by the picker to drop out-of-order resolves. Usage:
 *    const s = seq.next();  // snapshot at pick start
 *    const handle = await extractHandle(...);
 *    if (!seq.accept(s)) return; // a newer pick already committed
 */
export interface PickSequencer {
  next(): number
  accept(seq: number): boolean
}

export function makePickSequencer(): PickSequencer {
  let counter = 0
  let latestAccepted = -1
  return {
    next(): number {
      counter += 1
      return counter
    },
    accept(seq: number): boolean {
      if (seq > latestAccepted) {
        latestAccepted = seq
        return true
      }
      return false
    },
  }
}
