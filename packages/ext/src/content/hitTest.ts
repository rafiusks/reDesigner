/**
 * Document-rooted elementsFromPoint with shadow recursion for the picker.
 *
 * Spec §4.2 step 3: `document.elementsFromPoint` retargets picker shadow
 * content to the picker's shadow **host** via CSSOM-view retargeting. We
 * therefore:
 *
 *   (a) reject `el === pickerShadowHost` BEFORE any recursion so we never
 *       re-enter our own shadow tree;
 *   (b) when `el.shadowRoot` is an open root, recurse via
 *       `shadowRoot.elementsFromPoint` and re-apply the `getRootNode() ===
 *       pickerShadowRoot` filter at EVERY depth — retargeting only stops at
 *       entry points and deeper traversal through page-owned open shadows
 *       can still return nodes whose root chain walks through slot
 *       projection into ours;
 *   (c) closed roots are never entered by `elementsFromPoint` (retargeting
 *       stops at the host), so from outside `el.shadowRoot` is `null` and we
 *       return the host element as-is.
 *
 * `elementsFromPoint` takes CSS pixels, is a pure geometric query (ignores
 * `pointer-events`), honours CSS `zoom`, and does not descend into iframe
 * documents — it returns the `<iframe>` element. We rely on the browser's
 * spec-compliant behaviour for all four.
 */

export interface HitTestArgs {
  readonly x: number
  readonly y: number
  readonly pickerShadowHost: Element | null
  readonly pickerShadowRoot: ShadowRoot | null
}

/**
 * Returns the innermost non-picker element under (x, y) in CSS pixels, or
 * null. Never returns a node whose `getRootNode()` chain walks back into
 * `pickerShadowRoot` at any depth.
 */
export function hitTest(args: HitTestArgs): Element | null {
  const { x, y, pickerShadowHost, pickerShadowRoot } = args
  const candidates = document.elementsFromPoint(x, y)
  for (const el of candidates) {
    const resolved = resolveInShadow(el, x, y, pickerShadowHost, pickerShadowRoot)
    if (resolved) return resolved
  }
  return null
}

function resolveInShadow(
  el: Element,
  x: number,
  y: number,
  pickerShadowHost: Element | null,
  pickerShadowRoot: ShadowRoot | null,
): Element | null {
  // (a) reject the picker host outright — before we would ever enter our own shadow.
  if (pickerShadowHost && el === pickerShadowHost) return null
  if (isInPickerRoot(el, pickerShadowRoot)) return null

  // (b) open shadow root on this element: recurse.
  //     `el.shadowRoot` is only non-null for OPEN roots when accessed from
  //     outside the root. Closed roots remain opaque and we return the host.
  const inner = (el as Element & { shadowRoot: ShadowRoot | null }).shadowRoot
  if (inner && typeof inner.elementsFromPoint === 'function') {
    const innerCandidates = inner.elementsFromPoint(x, y)
    for (const child of innerCandidates) {
      if (child === el) continue // avoid pathological same-node recursion
      const resolved = resolveInShadow(child, x, y, pickerShadowHost, pickerShadowRoot)
      if (resolved) return resolved
    }
    // Nothing qualified inside the open shadow — do not fall through to the host.
    return null
  }

  return el
}

function isInPickerRoot(el: Element, pickerShadowRoot: ShadowRoot | null): boolean {
  if (!pickerShadowRoot) return false
  const visited = new Set<Node>()
  let root: Node = el.getRootNode()
  while (root instanceof ShadowRoot) {
    if (root === pickerShadowRoot) return true
    if (visited.has(root)) return false
    visited.add(root)
    const host = root.host as Element | null
    if (!host) return false
    root = host.getRootNode()
  }
  return false
}

/**
 * Spec §5.1: closestAcrossShadowDom walks `parentElement`; when null, hops
 * via `getRootNode().host` if the current root is an open ShadowRoot. Never
 * descends INTO closed shadow roots (the hop direction is outward).
 */
export function closestAcrossShadowDom(el: Element, selector: string): Element | null {
  let cur: Element | null = el
  const visited = new Set<Element>()
  while (cur) {
    if (visited.has(cur)) return null
    visited.add(cur)
    if (cur.matches(selector)) return cur
    const parent: Element | null = cur.parentElement
    if (parent) {
      cur = parent
      continue
    }
    const root = cur.getRootNode()
    if (root instanceof ShadowRoot) {
      cur = root.host as Element
      continue
    }
    return null
  }
  return null
}
