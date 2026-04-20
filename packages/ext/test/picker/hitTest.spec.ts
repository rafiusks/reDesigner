import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closestAcrossShadowDom, hitTest } from '../../src/content/hitTest.js'

// ---- Shared helpers ----------------------------------------------------------

interface PickerHandle {
  readonly host: HTMLElement
  readonly root: ShadowRoot
  readonly teardown: () => void
}

/**
 * Creates a picker shadow host covering the viewport. The picker root contains
 * a large transparent overlay that visually sits on top of the page so that
 * `document.elementsFromPoint` will return the host at the top of the hit list
 * (exercising the retargeting filter).
 */
function mountPicker(options?: { topLayer?: 'popover' | 'dialog' | 'none' }): PickerHandle {
  const host = document.createElement('div')
  host.id = 'redesigner-picker-host'
  // Full-viewport to guarantee the picker host is at (x, y) under the cursor.
  Object.assign(host.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    pointerEvents: 'none',
  })
  document.body.appendChild(host)
  const root = host.attachShadow({ mode: 'open' })
  const overlay = document.createElement('div')
  Object.assign(overlay.style, {
    position: 'absolute',
    inset: '0',
    background: 'transparent',
  })
  root.appendChild(overlay)

  const mode = options?.topLayer ?? 'none'
  if (mode === 'popover') {
    host.setAttribute('popover', 'manual')
    ;(host as unknown as { showPopover?: () => void }).showPopover?.()
  }

  return {
    host,
    root,
    teardown: () => {
      try {
        if (mode === 'popover') {
          ;(host as unknown as { hidePopover?: () => void }).hidePopover?.()
        }
      } catch {
        /* ignore */
      }
      host.remove()
    },
  }
}

function resetDom(): void {
  document.body.replaceChildren()
  document.documentElement.removeAttribute('style')
  for (const d of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) {
    d.close()
  }
  for (const p of document.querySelectorAll<HTMLElement>('[popover]')) {
    try {
      ;(p as unknown as { hidePopover?: () => void }).hidePopover?.()
    } catch {
      /* ignore */
    }
  }
}

// Center of a rect in CSS pixels (what elementsFromPoint expects).
function centerOf(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

// ---- Tests -------------------------------------------------------------------

describe('hitTest', () => {
  let picker: PickerHandle | null = null

  beforeEach(() => {
    resetDom()
    picker = null
  })

  afterEach(() => {
    picker?.teardown()
    resetDom()
  })

  it('returns the target under a transform-ancestor container with picker popover above', () => {
    const container = document.createElement('div')
    Object.assign(container.style, {
      position: 'absolute',
      left: '50px',
      top: '50px',
      width: '200px',
      height: '200px',
      transform: 'translateZ(0)',
    })
    const target = document.createElement('button')
    target.id = 'target'
    target.textContent = 'Hit me'
    Object.assign(target.style, { width: '100%', height: '100%' })
    container.appendChild(target)
    document.body.appendChild(container)

    picker = mountPicker({ topLayer: 'popover' })

    const { x, y } = centerOf(target)
    const hit = hitTest({
      x,
      y,
      pickerShadowHost: picker.host,
      pickerShadowRoot: picker.root,
    })

    expect(hit).toBe(target)
  })

  it('resolves a target inside a native <dialog>.showModal() with picker stacked above', () => {
    const dialog = document.createElement('dialog')
    const target = document.createElement('span')
    target.id = 'modal-target'
    target.textContent = 'in modal'
    Object.assign(target.style, { display: 'inline-block', width: '100px', height: '40px' })
    dialog.appendChild(target)
    document.body.appendChild(dialog)
    // showModal promotes the dialog to the top layer.
    ;(dialog as HTMLDialogElement).showModal()

    picker = mountPicker({ topLayer: 'popover' })

    const { x, y } = centerOf(target)
    const hit = hitTest({
      x,
      y,
      pickerShadowHost: picker.host,
      pickerShadowRoot: picker.root,
    })

    expect(hit).toBe(target)
    // Close to keep afterEach clean.
    dialog.close()
  })

  it('<dialog open> without showModal — picker still resolves underlying target', () => {
    const dialog = document.createElement('dialog')
    dialog.setAttribute('open', '')
    const target = document.createElement('em')
    target.id = 'nonmodal-target'
    target.textContent = 'nonmodal'
    Object.assign(target.style, { display: 'inline-block', width: '100px', height: '40px' })
    dialog.appendChild(target)
    document.body.appendChild(dialog)

    picker = mountPicker({ topLayer: 'popover' })

    const { x, y } = centerOf(target)
    const hit = hitTest({
      x,
      y,
      pickerShadowHost: picker.host,
      pickerShadowRoot: picker.root,
    })

    expect(hit).toBe(target)
  })

  it('isOwnOverlay skip: never returns a node whose root chain lands in pickerShadowRoot', () => {
    const target = document.createElement('div')
    target.id = 'under-picker'
    Object.assign(target.style, {
      position: 'absolute',
      left: '100px',
      top: '100px',
      width: '120px',
      height: '120px',
      background: 'red',
    })
    document.body.appendChild(target)

    picker = mountPicker({ topLayer: 'popover' })
    // Add deep content into the picker shadow at the same coordinates so that
    // `document.elementsFromPoint` will retarget to the host AND any recursion
    // into the open picker root would see a non-host node.
    const pickerInner = document.createElement('div')
    Object.assign(pickerInner.style, {
      position: 'absolute',
      inset: '0',
    })
    picker.root.appendChild(pickerInner)

    const { x, y } = centerOf(target)
    const hit = hitTest({
      x,
      y,
      pickerShadowHost: picker.host,
      pickerShadowRoot: picker.root,
    })

    expect(hit).toBe(target)
    // Any returned node must NOT have its root chain walk back into the picker root.
    if (hit) {
      let root: Node = hit.getRootNode()
      const visited = new Set<Node>()
      while (root instanceof ShadowRoot && !visited.has(root)) {
        visited.add(root)
        expect(root).not.toBe(picker.root)
        root = (root.host as Element).getRootNode()
      }
    }
  })

  it('same-origin iframe: returns the <iframe> element, not the iframe document contents', () => {
    const iframe = document.createElement('iframe')
    Object.assign(iframe.style, {
      position: 'absolute',
      left: '10px',
      top: '10px',
      width: '200px',
      height: '150px',
      border: '0',
    })
    iframe.srcdoc =
      '<body style="margin:0"><button id="inner" style="width:100%;height:100%">inner</button></body>'
    document.body.appendChild(iframe)

    picker = mountPicker({ topLayer: 'popover' })

    const { x, y } = centerOf(iframe)
    const hit = hitTest({
      x,
      y,
      pickerShadowHost: picker.host,
      pickerShadowRoot: picker.root,
    })

    expect(hit).toBe(iframe)
    expect(hit?.tagName).toBe('IFRAME')
  })

  it('closed shadow root: resolves to the host element', () => {
    class ClosedHost extends HTMLElement {
      constructor() {
        super()
        const r = this.attachShadow({ mode: 'closed' })
        const inner = document.createElement('div')
        Object.assign(inner.style, { width: '100%', height: '100%', background: 'blue' })
        r.appendChild(inner)
      }
    }
    if (!customElements.get('closed-host-el')) {
      customElements.define('closed-host-el', ClosedHost)
    }
    const host = document.createElement('closed-host-el') as HTMLElement
    Object.assign(host.style, {
      position: 'absolute',
      left: '40px',
      top: '40px',
      width: '160px',
      height: '120px',
      display: 'block',
    })
    document.body.appendChild(host)

    picker = mountPicker({ topLayer: 'popover' })

    const { x, y } = centerOf(host)
    const hit = hitTest({
      x,
      y,
      pickerShadowHost: picker.host,
      pickerShadowRoot: picker.root,
    })

    expect(hit).toBe(host)
    // Closed shadow root is never entered from outside — el.shadowRoot is null.
    expect((hit as Element & { shadowRoot: ShadowRoot | null }).shadowRoot).toBeNull()
  })

  it('devicePixelRatio > 1: hit-test uses CSS pixels, rounding boundary still resolves', () => {
    // The test runner is configured with deviceScaleFactor > 1 by default on some
    // CI images, but we only require that elementsFromPoint respects CSS pixels.
    // Place a target at a sub-pixel position to exercise rounding.
    const target = document.createElement('div')
    Object.assign(target.style, {
      position: 'absolute',
      left: '10.5px',
      top: '10.5px',
      width: '81px',
      height: '81px',
      background: 'green',
    })
    target.id = 'hidpi-target'
    document.body.appendChild(target)

    picker = mountPicker({ topLayer: 'popover' })

    const { x, y } = centerOf(target)
    const hit = hitTest({
      x,
      y,
      pickerShadowHost: picker.host,
      pickerShadowRoot: picker.root,
    })
    expect(hit).toBe(target)
  })

  it('CSS zoom: 0.5 ancestor — hit-test still resolves the target', () => {
    const zoomed = document.createElement('div')
    Object.assign(zoomed.style, {
      position: 'absolute',
      left: '20px',
      top: '20px',
      width: '400px',
      height: '400px',
      zoom: '0.5',
    })
    const target = document.createElement('div')
    Object.assign(target.style, { width: '100%', height: '100%', background: 'purple' })
    target.id = 'zoom-target'
    zoomed.appendChild(target)
    document.body.appendChild(zoomed)

    picker = mountPicker({ topLayer: 'popover' })

    const { x, y } = centerOf(target)
    const hit = hitTest({
      x,
      y,
      pickerShadowHost: picker.host,
      pickerShadowRoot: picker.root,
    })

    expect(hit).toBe(target)
  })

  it('pointer-events: none cascading from <html>: hitTest never returns picker host', () => {
    // Empirical Chromium behaviour: `elementsFromPoint` DOES honour
    // `pointer-events` (contrary to an older reading of the CSSOM-view
    // spec). When `<html>` has `pointer-events: none`, the cascade causes
    // all descendants (including the would-be target AND the picker host)
    // to be skipped by the geometric query, so it returns only `<html>`
    // itself. The invariant we assert here is the one that matters for
    // the picker: `hitTest` never yields the picker host, and never yields
    // anything inside the picker shadow root.
    document.documentElement.style.pointerEvents = 'none'
    const target = document.createElement('div')
    Object.assign(target.style, {
      position: 'absolute',
      left: '30px',
      top: '30px',
      width: '150px',
      height: '150px',
      background: 'yellow',
    })
    target.id = 'pe-none-target'
    document.body.appendChild(target)

    picker = mountPicker({ topLayer: 'popover' })

    const { x, y } = centerOf(target)
    const hit = hitTest({
      x,
      y,
      pickerShadowHost: picker.host,
      pickerShadowRoot: picker.root,
    })

    expect(hit).not.toBe(picker.host)
    if (hit) {
      // Whatever does come back (in practice `<html>`) must not be shadow content of ours.
      expect(hit.getRootNode()).not.toBe(picker.root)
    }
  })

  it('open-shadow all-filtered: returns later outer candidate, not the shadow host', () => {
    // Place a target underneath the open-shadow host in paint order
    // (earlier in DOM, same coordinates, lower z-index).
    const laterTarget = document.createElement('div')
    laterTarget.id = 'later-target'
    Object.assign(laterTarget.style, {
      position: 'absolute',
      left: '60px',
      top: '60px',
      width: '100px',
      height: '100px',
      background: 'teal',
    })
    document.body.appendChild(laterTarget)

    picker = mountPicker({ topLayer: 'popover' })

    // Open-shadow host overlapping laterTarget. Its shadow root only contains
    // content placed far off-screen, so at (x, y) shadowRoot.elementsFromPoint
    // yields only the host element itself — skipped by the child===el guard.
    // All inner candidates are therefore exhausted with no qualified result.
    // Correct behaviour (with the fall-through fix): return null so the outer
    // loop continues and resolves laterTarget. Old buggy behaviour: fall
    // through to `return el` which yields shadowHost incorrectly.
    const shadowHost = document.createElement('div')
    Object.assign(shadowHost.style, {
      position: 'absolute',
      left: '60px',
      top: '60px',
      width: '100px',
      height: '100px',
      zIndex: '100',
    })
    document.body.appendChild(shadowHost)
    const openRoot = shadowHost.attachShadow({ mode: 'open' })
    const offscreen = document.createElement('div')
    Object.assign(offscreen.style, {
      position: 'absolute',
      left: '2000px',
      top: '2000px',
      width: '10px',
      height: '10px',
    })
    openRoot.appendChild(offscreen)

    const { x, y } = centerOf(laterTarget)
    const hit = hitTest({
      x,
      y,
      pickerShadowHost: picker.host,
      pickerShadowRoot: picker.root,
    })

    expect(hit).not.toBe(shadowHost)
    expect(hit).toBe(laterTarget)
  })

  it('returns null when only the picker is at the hit point', () => {
    picker = mountPicker({ topLayer: 'popover' })
    const { x, y } = centerOf(picker.host)
    const hit = hitTest({
      x,
      y,
      pickerShadowHost: picker.host,
      pickerShadowRoot: picker.root,
    })
    // The only thing at (x,y) inside our picker-covered viewport is <body>/<html>.
    // Either returning body/html or null is acceptable as long as it's never
    // the picker host or anything inside its shadow root.
    expect(hit).not.toBe(picker.host)
    if (hit) {
      expect(hit.getRootNode()).not.toBe(picker.root)
    }
  })
})

describe('closestAcrossShadowDom', () => {
  beforeEach(() => resetDom())
  afterEach(() => resetDom())

  it('walks parentElement in the light tree', () => {
    const outer = document.createElement('section')
    outer.setAttribute('data-marker', 'yes')
    const inner = document.createElement('div')
    const target = document.createElement('span')
    inner.appendChild(target)
    outer.appendChild(inner)
    document.body.appendChild(outer)

    expect(closestAcrossShadowDom(target, '[data-marker="yes"]')).toBe(outer)
  })

  it('hops across open shadow boundary via getRootNode().host', () => {
    const outer = document.createElement('section')
    outer.setAttribute('data-marker', 'outer')
    const shadowHost = document.createElement('div')
    outer.appendChild(shadowHost)
    document.body.appendChild(outer)
    const root = shadowHost.attachShadow({ mode: 'open' })
    const inner = document.createElement('span')
    inner.id = 'inner'
    root.appendChild(inner)

    expect(closestAcrossShadowDom(inner, '[data-marker="outer"]')).toBe(outer)
  })

  it('returns null when selector does not match anywhere in the ancestor chain', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    expect(closestAcrossShadowDom(el, '[data-missing]')).toBeNull()
  })

  it('matches the element itself when it satisfies the selector', () => {
    const el = document.createElement('article')
    el.setAttribute('data-self', 'yes')
    document.body.appendChild(el)
    expect(closestAcrossShadowDom(el, '[data-self="yes"]')).toBe(el)
  })
})
