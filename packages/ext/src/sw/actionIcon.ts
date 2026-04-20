/**
 * actionIcon — debounced chrome.action.setIcon with leading+trailing flush.
 *
 * Coalescing invariant: 50 rapid arm/disarm toggles within the debounce window
 * that end on "disarmed" produce exactly 2 setIcon calls:
 *   1. leading-edge flush at first arm transition (false → true)
 *   2. trailing-edge flush at end of debounce window for final state
 */

const ARMED_ICON_PATH = 'icons/icon-armed.png'
const UNARMED_ICON_PATH = 'icons/icon-unarmed.png'

export interface ActionIcon {
  setArmed(tabId: number, armed: boolean): void
  /** Test hook — force any pending trailing flush immediately */
  flush(): void
  /** Returns the latest computed global armed state */
  current(): boolean
}

export function createActionIcon(opts?: {
  debounceMs?: number
  chromeAction?: typeof chrome.action
  tabsOpen?: () => number[]
}): ActionIcon {
  const debounceMs = opts?.debounceMs ?? 100
  const chromeAction = opts?.chromeAction ?? chrome.action

  const armedTabs = new Map<number, boolean>()
  let pendingFlush: ReturnType<typeof setTimeout> | null = null
  let lastFlushed = false

  function computeGlobal(): boolean {
    for (const armed of armedTabs.values()) {
      if (armed) return true
    }
    return false
  }

  function doFlush(value: boolean): void {
    const path = value ? ARMED_ICON_PATH : UNARMED_ICON_PATH
    lastFlushed = value
    chromeAction.setIcon({ path })
  }

  function onStateChange(): void {
    const cur = computeGlobal()

    if (pendingFlush === null) {
      // Not in an active burst. Only act if state differs from last flushed.
      if (cur === lastFlushed) return
      // Leading-edge flush immediately.
      doFlush(cur)
    }

    // Always reschedule the trailing flush within a burst window.
    // This debounces mid-burst toggles; the timer captures the final state.
    if (pendingFlush !== null) clearTimeout(pendingFlush)
    pendingFlush = setTimeout(() => {
      pendingFlush = null
      const final = computeGlobal()
      if (final !== lastFlushed) doFlush(final)
    }, debounceMs)
  }

  function setArmed(tabId: number, armed: boolean): void {
    armedTabs.set(tabId, armed)
    onStateChange()
  }

  function flush(): void {
    if (pendingFlush !== null) {
      clearTimeout(pendingFlush)
      pendingFlush = null
    }
    const cur = computeGlobal()
    if (cur !== lastFlushed) doFlush(cur)
  }

  function current(): boolean {
    return computeGlobal()
  }

  return { setArmed, flush, current }
}
