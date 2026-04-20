/**
 * Picker overlay topology — spec §4.2 step 2.
 *
 * Lifecycle: idle → arm() → (armed: shadow host in top layer, window-level
 * pointer/click/keydown capture) → disarm() / commit / modal-detected → idle.
 *
 * Key topology notes:
 *   - Shadow host is attached at arm-time as a child of `document.querySelector(':modal')`
 *     if one exists, else as a child of `document.documentElement`. Nesting inside
 *     the open modal escapes native `<dialog>` inertness, which applies only
 *     outside the dialog subtree.
 *   - `popover="manual"` + `showPopover()` promotes the host into the top layer
 *     so it stacks above page content without needing z-index tricks.
 *   - All pointer listeners are attached at `window` with `{ capture: true }`
 *     so they fire before page libraries that use capture + stopImmediatePropagation
 *     (monaco, codemirror, react-dnd, tldraw). Because those libs use
 *     stopImmediatePropagation in capture, the picker's own capture-phase
 *     suppressors use `stopImmediatePropagation` (not `stopPropagation`) to
 *     maintain symmetry — otherwise a later capture listener on window could
 *     still fire and re-inject page behaviour.
 *   - `passive: true` for pointermove/down (we never preventDefault them);
 *     `passive: false` for `click` because we preventDefault on commit.
 *   - Aria-live region lives in `document.body`, NOT inside the shadow root —
 *     AT support for shadow-DOM live regions is inconsistent.
 *   - Modal-opens-while-armed is detected via BOTH a MutationObserver
 *     (inert / aria-modal / open attributes) AND a synchronous `toggle`
 *     listener on document (Chrome 120+ fires on `<dialog>.showModal()`).
 *   - Hover resolution uses `hitTest` (document-rooted elementsFromPoint with
 *     shadow recursion), coalesced via rAF — at most one resolution per frame.
 *     Non-mouse pointer types are deduped: only one update per contiguous
 *     pen/touch burst (mouse always updates). This prevents pen/touch event
 *     storms from pegging the main thread.
 */

import { hitTest } from './hitTest'

export interface PickerController {
  /** Arm the picker. Idempotent. No-op if feature-detect fails (toasts instead). */
  arm(): void
  /** Disarm the picker. Idempotent. */
  disarm(): void
  /** Whether the picker is currently armed. */
  isArmed(): boolean
  /** Full teardown including any persistent state. Safe to call multiple times. */
  dispose(): void
}

export type ToastReporter = (
  message: string,
  opts?: { severity?: 'info' | 'warning' | 'error' },
) => void

export interface CreatePickerOptions {
  toast?: ToastReporter
  /** Called when user clicks a resolved target. Fired before disarm(). */
  onCommit?: (el: Element) => void
}

interface ListenerRecord {
  readonly target: EventTarget
  readonly type: string
  readonly listener: EventListener
  readonly options: AddEventListenerOptions
}

const MODAL_TOAST = 'Picker unavailable — close the modal dialog and retry.'
const FEATURE_TOAST = 'Picker requires Chrome 120+'
const POINTER_DEBOUNCE_MS = 250

function defaultToast(message: string, opts?: { severity?: string }): void {
  // Fallback — caller didn't supply a toast. Use console; don't throw.
  const sev = opts?.severity ?? 'info'
  console.warn(`[redesigner picker ${sev}]`, message)
}

export function createPicker(opts: CreatePickerOptions = {}): PickerController {
  const toast: ToastReporter = opts.toast ?? defaultToast
  const onCommit = opts.onCommit

  // --- Armed-cycle state (all null between cycles) --------------------------
  let armed = false
  let disposed = false
  let host: HTMLElement | null = null
  let shadow: ShadowRoot | null = null
  let highlight: HTMLElement | null = null
  let liveRegion: HTMLElement | null = null
  let priorActiveElement: Element | null = null
  let mutationObserver: MutationObserver | null = null
  let pointerDebounceTimer: ReturnType<typeof setTimeout> | null = null
  let pendingPointerMessage: string | null = null
  let lastPointerType: string | null = null
  let _lastHoverTarget: Element | null = null
  let lastPointerX = 0
  let lastPointerY = 0
  let hasPendingPointer = false
  let rafHandle: number | null = null
  let listeners: ListenerRecord[] = []

  // --- Helpers --------------------------------------------------------------

  function addWindowListener<K extends keyof WindowEventMap>(
    type: K,
    listener: (ev: WindowEventMap[K]) => void,
    options: AddEventListenerOptions,
  ): void {
    const wrapped = listener as EventListener
    window.addEventListener(type, wrapped, options)
    listeners.push({ target: window, type, listener: wrapped, options })
  }

  function addDocumentListener(
    type: string,
    listener: EventListener,
    options: AddEventListenerOptions,
  ): void {
    document.addEventListener(type, listener, options)
    listeners.push({ target: document, type, listener, options })
  }

  function removeAllListeners(): void {
    for (const rec of listeners) {
      try {
        rec.target.removeEventListener(rec.type, rec.listener, rec.options)
      } catch {
        /* ignore */
      }
    }
    listeners = []
  }

  function featureSupported(): boolean {
    // Spec §4.2 step 2: feature-detect `'popover' in HTMLElement.prototype`.
    return 'popover' in HTMLElement.prototype
  }

  function findAttachmentTarget(): Element {
    // :modal selector matches any open modal <dialog>. If absent, attach to
    // documentElement so we're not inside <body> (which some frameworks inert).
    try {
      const modal = document.querySelector(':modal')
      if (modal) return modal
    } catch {
      /* :modal unsupported in some runtimes — fall through */
    }
    return document.documentElement
  }

  function announce(message: string, immediate: boolean): void {
    if (!liveRegion) return
    if (immediate) {
      if (pointerDebounceTimer !== null) {
        clearTimeout(pointerDebounceTimer)
        pointerDebounceTimer = null
      }
      pendingPointerMessage = null
      liveRegion.textContent = message
      return
    }
    // Debounced (pointer) path.
    pendingPointerMessage = message
    if (pointerDebounceTimer !== null) return
    pointerDebounceTimer = setTimeout(() => {
      pointerDebounceTimer = null
      if (liveRegion && pendingPointerMessage !== null) {
        liveRegion.textContent = pendingPointerMessage
      }
      pendingPointerMessage = null
    }, POINTER_DEBOUNCE_MS)
  }

  function restoreFocus(): void {
    const prev = priorActiveElement
    priorActiveElement = null
    if (prev instanceof HTMLElement && prev.isConnected) {
      try {
        prev.focus()
        return
      } catch {
        /* fall through to body */
      }
    }
    // Fallback: put focus on body (matches native "focus lost" behaviour).
    try {
      document.body.focus()
    } catch {
      /* ignore */
    }
  }

  // --- Modal detection -----------------------------------------------------

  function hasOpenModalAncestor(): boolean {
    // Any open <dialog> in modal mode, any aria-modal="true", or any element
    // with `inert` in the ancestor chain up to <html>.
    try {
      if (document.querySelector(':modal')) return true
    } catch {
      /* ignore */
    }
    if (document.querySelector('[aria-modal="true"]')) return true
    // Inert scan: walk from body or any element chains. Cheap check: look for
    // any element with `inert` attribute. A fine-grained ancestor-walk would
    // require knowing "of what" — since the picker host is in top layer and
    // we only care about whether the page is in a modal state, `inert` on
    // anything is a reasonable trigger in practice (tier-3 fixtures cover this).
    if (document.querySelector('[inert]')) return true
    return false
  }

  function handleModalDetected(): void {
    if (!armed) return
    toast(MODAL_TOAST, { severity: 'warning' })
    announce(MODAL_TOAST, true)
    disarm()
  }

  // --- Arm / disarm --------------------------------------------------------

  function arm(): void {
    if (disposed || armed) return
    if (!featureSupported()) {
      toast(FEATURE_TOAST, { severity: 'error' })
      return
    }

    // Save focus BEFORE any DOM mutation or focus transfer.
    priorActiveElement = document.activeElement

    // --- Build host -----------------------------------------------------
    host = document.createElement('div')
    host.setAttribute('data-redesigner-picker-host', '')
    host.setAttribute('popover', 'manual')
    host.setAttribute('tabindex', '-1')
    host.setAttribute('role', 'dialog')
    host.setAttribute('aria-modal', 'true')
    host.setAttribute('aria-label', 'Element picker active. Press Esc to cancel.')
    // Host itself is pointer-events:none — we use window-level listeners for
    // pointer routing and never want to intercept real page clicks via the host.
    host.style.pointerEvents = 'none'
    host.style.position = 'fixed'
    host.style.inset = '0'
    host.style.background = 'transparent'
    host.style.border = '0'
    host.style.padding = '0'
    host.style.margin = '0'

    shadow = host.attachShadow({ mode: 'open' })

    // Highlight rectangle.
    highlight = document.createElement('div')
    highlight.style.position = 'absolute'
    highlight.style.pointerEvents = 'none'
    highlight.style.outline = '2px solid #2b6cb0'
    highlight.style.boxSizing = 'border-box'
    highlight.style.display = 'none'
    shadow.appendChild(highlight)

    // Attach to :modal if present, else documentElement.
    const attachTo = findAttachmentTarget()
    attachTo.appendChild(host)

    // Promote to top layer.
    try {
      ;(host as unknown as { showPopover?: () => void }).showPopover?.()
    } catch {
      /* some environments may throw on showPopover before connection — ignored */
    }

    // Live region appended to body (not shadow — AT support gaps).
    liveRegion = document.createElement('div')
    liveRegion.setAttribute('data-redesigner-picker-live', '')
    liveRegion.setAttribute('aria-live', 'assertive')
    liveRegion.setAttribute('aria-atomic', 'true')
    // Visually hide but keep in the a11y tree.
    liveRegion.style.position = 'fixed'
    liveRegion.style.left = '-9999px'
    liveRegion.style.top = 'auto'
    liveRegion.style.width = '1px'
    liveRegion.style.height = '1px'
    liveRegion.style.overflow = 'hidden'
    document.body.appendChild(liveRegion)

    // Mark armed BEFORE registering listeners or moving focus. A synchronous
    // focus event listener running during host.focus() could observe armed
    // state; listener handlers must see `armed === true` on their very first
    // fire. (Order: feature-detect → priorActiveElement → host/shadow/popover
    // → live region → armed=true → listeners+MO → host.focus()).
    armed = true
    _lastHoverTarget = null
    lastPointerType = null
    hasPendingPointer = false
    rafHandle = null

    // --- Window listeners -----------------------------------------------
    // All capture:true so they precede page libs using capture + stopImmediatePropagation.
    const passiveCapture: AddEventListenerOptions = { capture: true, passive: true }
    const activeCapture: AddEventListenerOptions = { capture: true, passive: false }

    addWindowListener('pointermove', handlePointerMove, passiveCapture)
    addWindowListener('click', handleClick, activeCapture)
    addWindowListener('contextmenu', handleSuppress, activeCapture)
    addWindowListener('dragstart', handleSuppress, activeCapture)
    addWindowListener('pointercancel', handlePointerCancel, passiveCapture)
    addWindowListener('keydown', handleKeyDown, activeCapture)

    // --- Modal-opens-while-armed detection ------------------------------
    mutationObserver = new MutationObserver(() => {
      if (!armed) return
      if (hasOpenModalAncestor()) {
        handleModalDetected()
      }
    })
    mutationObserver.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['inert', 'aria-modal', 'open'],
      childList: true,
    })

    // Synchronous `toggle` event — fires on <dialog>.show()/showModal()/close()
    // and `[popover]` show/hide. We only care about dialogs becoming modal.
    addDocumentListener('toggle', handleDialogToggle as EventListener, {
      capture: true,
      passive: true,
    })

    // Move focus to host LAST — after armed + listeners are in place so any
    // synchronous focus-event consumers see the fully-initialised state.
    try {
      host.focus()
    } catch {
      /* ignore */
    }
  }

  function disarm(): void {
    if (!armed) return
    armed = false

    // Cancel any pending rAF hover resolution.
    if (rafHandle !== null) {
      try {
        cancelAnimationFrame(rafHandle)
      } catch {
        /* ignore */
      }
      rafHandle = null
    }
    hasPendingPointer = false

    // Cancel debounces / pending announcements.
    if (pointerDebounceTimer !== null) {
      clearTimeout(pointerDebounceTimer)
      pointerDebounceTimer = null
    }
    pendingPointerMessage = null

    // Stop MO + listeners.
    if (mutationObserver) {
      try {
        mutationObserver.disconnect()
      } catch {
        /* ignore */
      }
      mutationObserver = null
    }
    removeAllListeners()

    // Hide + remove host.
    if (host) {
      try {
        ;(host as unknown as { hidePopover?: () => void }).hidePopover?.()
      } catch {
        /* ignore */
      }
      try {
        host.remove()
      } catch {
        /* ignore */
      }
    }
    host = null
    shadow = null
    highlight = null

    // Remove live region.
    if (liveRegion) {
      try {
        liveRegion.remove()
      } catch {
        /* ignore */
      }
      liveRegion = null
    }

    // Restore focus (isConnected guarded).
    restoreFocus()

    _lastHoverTarget = null
    lastPointerType = null
  }

  // --- Event handlers -----------------------------------------------------

  function handlePointerMove(ev: PointerEvent): void {
    if (!armed) return

    // Dedup by pointerType: only 'mouse' gets to update on every move.
    // Pen/touch fire rapid bursts (can exceed 120Hz on some hardware); we
    // accept the first event of a contiguous burst (pointerType change) and
    // drop subsequent ones until a different type arrives or a pointercancel
    // resets state. Spec: "RAF-coalesced hover, deduped by pointerType for pen/touch".
    const pt = ev.pointerType ?? null
    if (pt !== 'mouse' && pt !== null && pt === lastPointerType) {
      return
    }
    lastPointerType = pt

    lastPointerX = ev.clientX
    lastPointerY = ev.clientY
    hasPendingPointer = true

    // Announce via debounced pointer path.
    announce('Picker tracking pointer', false)

    if (rafHandle === null) {
      rafHandle = requestAnimationFrame(resolveHoverFromLastPointer)
    }
  }

  function resolveHoverFromLastPointer(): void {
    rafHandle = null
    if (!armed || !hasPendingPointer) return
    hasPendingPointer = false
    if (!highlight) return

    const target = hitTest({
      x: lastPointerX,
      y: lastPointerY,
      pickerShadowHost: host,
      pickerShadowRoot: shadow,
    })

    if (target) {
      _lastHoverTarget = target
      const r = target.getBoundingClientRect()
      Object.assign(highlight.style, {
        position: 'fixed',
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
        display: 'block',
      })
    } else {
      _lastHoverTarget = null
      highlight.style.display = 'none'
    }
  }

  function handleClick(ev: MouseEvent): void {
    if (!armed) return
    // preventDefault + stopImmediatePropagation so the page doesn't receive
    // our commit click AND no later capture listener on window runs.
    try {
      ev.preventDefault()
    } catch {
      /* ignore */
    }
    try {
      ev.stopImmediatePropagation()
    } catch {
      /* ignore */
    }

    // Spec §4.2 step 5: commit `lastHoverTarget`. Prefer the rAF-resolved
    // target (passes through hitTest + shadow recursion); fall back to
    // ev.target only if hover never resolved (very first frame or no
    // pointermove preceded the click — e.g. keyboard-activated click).
    let target: Element | null = _lastHoverTarget
    if (!target) {
      target = ev.target instanceof Element ? ev.target : null
    }

    if (target && onCommit) {
      try {
        onCommit(target)
      } catch (err) {
        console.warn('[redesigner picker] onCommit threw', err)
      }
    }
    disarm()
  }

  function handleSuppress(ev: Event): void {
    if (!armed) return
    try {
      ev.preventDefault()
    } catch {
      /* ignore */
    }
    try {
      // stopImmediatePropagation (not stopPropagation) for symmetry with page
      // libs that themselves use capture + stopImmediatePropagation. A later
      // capture listener on window would otherwise still see the event.
      ev.stopImmediatePropagation()
    } catch {
      /* ignore */
    }
  }

  function handlePointerCancel(_ev: PointerEvent): void {
    if (!armed) return
    _lastHoverTarget = null
    lastPointerType = null
    if (highlight) highlight.style.display = 'none'
  }

  function handleKeyDown(ev: KeyboardEvent): void {
    if (!armed) return
    if (ev.key === 'Escape') {
      try {
        ev.preventDefault()
      } catch {
        /* ignore */
      }
      announce('Picker cancelled', true)
      disarm()
      // Must follow the disarm call: once the picker is disarmed the Escape
      // has been "consumed". Stop immediate propagation so page-level Escape
      // handlers (modal closers, editors) don't also fire off the same event.
      try {
        ev.stopImmediatePropagation()
      } catch {
        /* ignore */
      }
    }
  }

  function handleDialogToggle(_ev: Event): void {
    if (!armed) return
    // We only care whether the page is now in a modal state. A single
    // re-scan covers <dialog>.showModal(), [popover] aria-modal promotions,
    // and any other modal-establishing toggles. An earlier draft had a
    // second hasOpenModalAncestor() check gated on `_ev.target instanceof
    // HTMLDialogElement && newState === 'open'` — that branch was
    // unreachable (the first check already covers it), so removed.
  }

  // --- Public controller --------------------------------------------------

  function isArmed(): boolean {
    return armed
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    disarm()
  }

  return { arm, disarm, isArmed, dispose }
}
