import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type PickerController,
  type ToastReporter,
  createPicker,
} from '../../src/content/picker.js'

// ---- Helpers -----------------------------------------------------------------

function resetDom(): void {
  document.body.replaceChildren()
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('inert')
  document.documentElement.removeAttribute('aria-modal')
  for (const d of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) {
    try {
      d.close()
    } catch {
      /* ignore */
    }
  }
  for (const p of document.querySelectorAll<HTMLElement>('[popover]')) {
    try {
      ;(p as unknown as { hidePopover?: () => void }).hidePopover?.()
    } catch {
      /* ignore */
    }
  }
}

function findPickerHost(): HTMLElement | null {
  // The host has a data-attribute we control; prefer that over role-based lookup
  // because jsdom/browsers may have other role=dialog elements in the page.
  return document.querySelector<HTMLElement>('[data-redesigner-picker-host]')
}

function findLiveRegion(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-redesigner-picker-live]')
}

function makeToast(): ToastReporter & { calls: Array<{ message: string; severity?: string }> } {
  const calls: Array<{ message: string; severity?: string }> = []
  const fn = ((message: string, opts?: { severity?: 'info' | 'warning' | 'error' }) => {
    calls.push({ message, ...(opts?.severity ? { severity: opts.severity } : {}) })
  }) as ToastReporter & { calls: typeof calls }
  fn.calls = calls
  return fn
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((r) => requestAnimationFrame(() => r()))
}

async function microtask(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

// ---- Tests -------------------------------------------------------------------

describe('createPicker — shadow host topology', () => {
  let picker: PickerController | null = null

  beforeEach(() => {
    resetDom()
    picker = null
    vi.useRealTimers()
  })

  afterEach(() => {
    picker?.dispose()
    picker = null
    resetDom()
  })

  it('attaches the shadow host as a child of documentElement when no :modal is open', () => {
    const toast = makeToast()
    picker = createPicker({ toast })
    picker.arm()

    const host = findPickerHost()
    expect(host).not.toBeNull()
    expect(host?.parentElement).toBe(document.documentElement)
    expect(picker.isArmed()).toBe(true)
  })

  it('attaches the shadow host as a child of an already-open :modal dialog at arm-time', () => {
    const dialog = document.createElement('dialog')
    document.body.appendChild(dialog)
    dialog.showModal()

    picker = createPicker()
    picker.arm()

    const host = findPickerHost()
    expect(host).not.toBeNull()
    expect(host?.parentElement).toBe(dialog)
  })

  it('feature-detect miss: toasts an error and does not mutate DOM', () => {
    // Only the own-prototype descriptor signals `in` membership at that depth.
    // `'popover' in HTMLElement.prototype` also returns true if Element.prototype
    // defines it via inheritance — which it does not in Chromium. We remove the
    // own property and restore it in a finally block.
    const originalHasPopover = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'popover')
    if (!originalHasPopover) {
      // Environment doesn't advertise popover at all — skip the negative test.
      return
    }
    try {
      // biome-ignore lint/performance/noDelete: intentional to flip `in` check
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).popover
      expect('popover' in HTMLElement.prototype).toBe(false)

      const toast = makeToast()
      picker = createPicker({ toast })
      picker.arm()

      expect(toast.calls).toHaveLength(1)
      expect(toast.calls[0]?.severity).toBe('error')
      expect(findPickerHost()).toBeNull()
      expect(picker.isArmed()).toBe(false)
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'popover', originalHasPopover)
    }
  })

  it('host has correct a11y attributes', () => {
    picker = createPicker()
    picker.arm()

    const host = findPickerHost()
    expect(host).not.toBeNull()
    expect(host?.getAttribute('popover')).toBe('manual')
    expect(host?.getAttribute('role')).toBe('dialog')
    expect(host?.getAttribute('aria-modal')).toBe('true')
    expect(host?.getAttribute('aria-label')).toMatch(/picker/i)
    expect(host?.getAttribute('tabindex')).toBe('-1')
  })

  it('calls showPopover() on the host', () => {
    // Mount a spy via prototype intercept: wrap showPopover for the duration of this test.
    const original = HTMLElement.prototype.showPopover
    const callThisValues: unknown[] = []
    const spy = vi.fn(function (this: HTMLElement) {
      callThisValues.push(this)
      return original.call(this)
    })
    HTMLElement.prototype.showPopover = spy as typeof HTMLElement.prototype.showPopover

    try {
      picker = createPicker()
      picker.arm()
      const host = findPickerHost()
      expect(spy).toHaveBeenCalled()
      expect(callThisValues.some((inst) => inst === host)).toBe(true)
    } finally {
      HTMLElement.prototype.showPopover = original
    }
  })

  it('focus: moves focus to host on arm and restores to previous activeElement on disarm', () => {
    const button = document.createElement('button')
    button.textContent = 'origin'
    document.body.appendChild(button)
    button.focus()
    expect(document.activeElement).toBe(button)

    picker = createPicker()
    picker.arm()

    const host = findPickerHost()
    expect(document.activeElement).toBe(host)

    picker.disarm()
    expect(document.activeElement).toBe(button)
  })

  it('focus restore: isConnected guard falls back to body.focus() when prior activeElement is removed', () => {
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.focus()

    picker = createPicker()
    picker.arm()

    // Remove the prior active element while picker is armed.
    button.remove()
    picker.disarm()

    // document.body.focus() leaves activeElement as body (or equivalent). Most
    // importantly, activeElement is NOT the detached button.
    expect(document.activeElement).not.toBe(button)
  })
})

describe('createPicker — live region & announcements', () => {
  let picker: PickerController | null = null

  beforeEach(() => {
    resetDom()
    vi.useRealTimers()
  })

  afterEach(() => {
    picker?.dispose()
    picker = null
    resetDom()
  })

  it('creates an aria-live region in document.body (not in shadow root)', () => {
    picker = createPicker()
    picker.arm()

    const live = findLiveRegion()
    expect(live).not.toBeNull()
    expect(live?.parentElement).toBe(document.body)
    expect(live?.getAttribute('aria-live')).toBe('assertive')
    expect(live?.getAttribute('aria-atomic')).toBe('true')
  })

  it('pointer-driven announcements debounce at 250ms; keyboard-driven are immediate', async () => {
    vi.useFakeTimers()
    picker = createPicker()
    picker.arm()
    const live = findLiveRegion()
    expect(live).not.toBeNull()

    // Fire two pointer announcements within the debounce window.
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 10 }))
    vi.advanceTimersByTime(100)
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 20, clientY: 20 }))
    // Neither should have flushed yet (debounce trailing-edge).
    // After advancing a further 260ms, a single announcement should appear.
    vi.advanceTimersByTime(260)
    const afterPointer = live?.textContent ?? ''
    expect(afterPointer.length).toBeGreaterThan(0)

    // Keyboard (Esc) announcement is immediate — no debounce.
    const before = live?.textContent ?? ''
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    // No timer advance required; change should be synchronous.
    const after = live?.textContent ?? ''
    expect(after).not.toBe(before)
  })
})

describe('createPicker — window listeners & event suppression', () => {
  let picker: PickerController | null = null

  beforeEach(() => {
    resetDom()
    vi.useRealTimers()
  })

  afterEach(() => {
    picker?.dispose()
    picker = null
    resetDom()
  })

  it('suppresses contextmenu and dragstart during arm; does not suppress after disarm', () => {
    picker = createPicker()
    picker.arm()

    const cm = new Event('contextmenu', { bubbles: true, cancelable: true })
    window.dispatchEvent(cm)
    expect(cm.defaultPrevented).toBe(true)

    const ds = new Event('dragstart', { bubbles: true, cancelable: true })
    window.dispatchEvent(ds)
    expect(ds.defaultPrevented).toBe(true)

    picker.disarm()

    const cm2 = new Event('contextmenu', { bubbles: true, cancelable: true })
    window.dispatchEvent(cm2)
    expect(cm2.defaultPrevented).toBe(false)

    const ds2 = new Event('dragstart', { bubbles: true, cancelable: true })
    window.dispatchEvent(ds2)
    expect(ds2.defaultPrevented).toBe(false)
  })

  it('Esc keydown during arm disarms the picker', () => {
    picker = createPicker()
    picker.arm()
    expect(picker.isArmed()).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(picker.isArmed()).toBe(false)
    expect(findPickerHost()).toBeNull()
  })

  it('click during arm commits and disarms; preventDefault is applied', () => {
    const target = document.createElement('a')
    target.href = 'http://example.invalid/'
    target.textContent = 'link'
    Object.assign(target.style, {
      position: 'absolute',
      left: '10px',
      top: '10px',
      width: '80px',
      height: '40px',
    })
    document.body.appendChild(target)

    const onCommit = vi.fn()
    picker = createPicker({ onCommit })
    picker.arm()

    const rect = target.getBoundingClientRect()
    const click = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 5,
      clientY: rect.top + 5,
    })
    target.dispatchEvent(click)

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit.mock.calls[0]?.[0]).toBeInstanceOf(Element)
    expect(click.defaultPrevented).toBe(true)
    expect(picker.isArmed()).toBe(false)
  })

  it('pointercancel resets hover state (does not throw; picker remains armed)', () => {
    picker = createPicker()
    picker.arm()
    expect(() => {
      window.dispatchEvent(new PointerEvent('pointercancel'))
    }).not.toThrow()
    expect(picker.isArmed()).toBe(true)
  })
})

describe('createPicker — modal-opens-while-armed detection', () => {
  let picker: PickerController | null = null

  beforeEach(() => {
    resetDom()
    vi.useRealTimers()
  })

  afterEach(() => {
    picker?.dispose()
    picker = null
    resetDom()
  })

  it('aborts pick when a native <dialog>.showModal() fires while armed', async () => {
    const toast = makeToast()
    picker = createPicker({ toast })
    picker.arm()
    expect(picker.isArmed()).toBe(true)

    const dialog = document.createElement('dialog')
    document.body.appendChild(dialog)
    dialog.showModal()

    // Toggle event is synchronous in Chrome 120+; MO is the async fallback.
    await microtask()
    await nextFrame()
    await microtask()

    expect(picker.isArmed()).toBe(false)
    expect(toast.calls.some((c) => /modal/i.test(c.message))).toBe(true)
  })

  it('aborts pick when `inert` is added to an ancestor while armed', async () => {
    const toast = makeToast()
    picker = createPicker({ toast })
    picker.arm()

    const wrapper = document.createElement('div')
    document.body.appendChild(wrapper)
    // Inert on documentElement (ancestor chain up to <html>).
    document.documentElement.setAttribute('inert', '')

    // Wait for MutationObserver microtask delivery.
    await microtask()
    await nextFrame()
    await microtask()

    expect(picker.isArmed()).toBe(false)
    expect(toast.calls.some((c) => /modal/i.test(c.message))).toBe(true)

    document.documentElement.removeAttribute('inert')
    wrapper.remove()
  })

  it('aborts pick when aria-modal="true" appears on an element while armed', async () => {
    const toast = makeToast()
    picker = createPicker({ toast })
    picker.arm()

    const fake = document.createElement('div')
    document.body.appendChild(fake)
    fake.setAttribute('aria-modal', 'true')

    await microtask()
    await nextFrame()
    await microtask()

    expect(picker.isArmed()).toBe(false)
    expect(toast.calls.some((c) => /modal/i.test(c.message))).toBe(true)
  })
})

describe('createPicker — idempotency & dispose', () => {
  let picker: PickerController | null = null

  beforeEach(() => {
    resetDom()
    vi.useRealTimers()
  })

  afterEach(() => {
    picker?.dispose()
    picker = null
    resetDom()
  })

  it('arm() and disarm() are idempotent', () => {
    picker = createPicker()
    picker.arm()
    picker.arm()
    expect(document.querySelectorAll('[data-redesigner-picker-host]').length).toBe(1)
    expect(picker.isArmed()).toBe(true)
    picker.disarm()
    picker.disarm()
    expect(picker.isArmed()).toBe(false)
    expect(findPickerHost()).toBeNull()
  })

  it('dispose() while armed tears everything down', () => {
    picker = createPicker()
    picker.arm()
    picker.dispose()
    expect(findPickerHost()).toBeNull()
    expect(findLiveRegion()).toBeNull()
    expect(picker.isArmed()).toBe(false)

    // Dispatch events after dispose — should be no-op, no throws, no listeners.
    const cm = new Event('contextmenu', { bubbles: true, cancelable: true })
    window.dispatchEvent(cm)
    expect(cm.defaultPrevented).toBe(false)
  })

  it('dispose() without arming is safe', () => {
    picker = createPicker()
    expect(() => picker?.dispose()).not.toThrow()
  })
})
