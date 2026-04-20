/**
 * panelPort — per-(windowId, tabId) snapshot cache for useSyncExternalStore.
 *
 * Key invariant: getSnapshot() / getServerSnapshot() return Object.is-identical
 * refs for every call until push() or onTabActivated() bumps the version.
 */

export interface PanelSnapshot {
  readonly status: 'hydrating' | 'connected' | 'disconnected' | 'mcp-missing'
  readonly tabId: number
  readonly windowId: number
  readonly selection: unknown | null
  readonly pickerArmed: boolean
  readonly recent: readonly unknown[]
  readonly version: number
}

export interface PanelPort {
  /** Wire to chrome.runtime.onConnect in index.ts */
  onConnect(port: chrome.runtime.Port): void
  /** Push a partial update; bumps version and replaces cached ref */
  push(
    windowId: number,
    tabId: number,
    snapshot: Partial<Omit<PanelSnapshot, 'tabId' | 'windowId' | 'version'>>,
  ): void
  /** Stable ref via useSyncExternalStore contract */
  getSnapshot(windowId: number, tabId: number): PanelSnapshot
  /** Same contract as getSnapshot (used in server-side rendering path) */
  getServerSnapshot(windowId: number, tabId: number): PanelSnapshot
  /** Bumps version without changing other fields — forces React to re-pull */
  onTabActivated(windowId: number, tabId: number): void
}

function makeKey(windowId: number, tabId: number): string {
  return `${windowId}:${tabId}`
}

function makeDefaultSnapshot(windowId: number, tabId: number): PanelSnapshot {
  return {
    status: 'hydrating',
    tabId,
    windowId,
    selection: null,
    pickerArmed: false,
    recent: [],
    version: 0,
  }
}

export function createPanelPort(): PanelPort {
  const cache = new Map<string, PanelSnapshot>()

  function getOrCreate(windowId: number, tabId: number): PanelSnapshot {
    const key = makeKey(windowId, tabId)
    let snap = cache.get(key)
    if (!snap) {
      snap = makeDefaultSnapshot(windowId, tabId)
      cache.set(key, snap)
    }
    return snap
  }

  function push(
    windowId: number,
    tabId: number,
    partial: Partial<Omit<PanelSnapshot, 'tabId' | 'windowId' | 'version'>>,
  ): void {
    const key = makeKey(windowId, tabId)
    const current = getOrCreate(windowId, tabId)
    const next: PanelSnapshot = {
      ...current,
      ...partial,
      tabId,
      windowId,
      version: current.version + 1,
    }
    cache.set(key, next)
  }

  function getSnapshot(windowId: number, tabId: number): PanelSnapshot {
    return getOrCreate(windowId, tabId)
  }

  function getServerSnapshot(windowId: number, tabId: number): PanelSnapshot {
    return getOrCreate(windowId, tabId)
  }

  function onTabActivated(windowId: number, tabId: number): void {
    const key = makeKey(windowId, tabId)
    const current = getOrCreate(windowId, tabId)
    const next: PanelSnapshot = { ...current, version: current.version + 1 }
    cache.set(key, next)
  }

  function onConnect(port: chrome.runtime.Port): void {
    // Extract tabId and windowId from port sender or name
    const tabId = port.sender?.tab?.id
    const windowId = port.sender?.tab?.windowId

    if (tabId !== undefined && windowId !== undefined) {
      const snap = getOrCreate(windowId, tabId)
      port.postMessage({ snapshot: snap })
    }

    port.onDisconnect.addListener(() => {
      // Cleanup: no persistent state to remove, but mark disconnected if tracked
      if (tabId !== undefined && windowId !== undefined) {
        const current = cache.get(makeKey(windowId, tabId))
        if (current) {
          push(windowId, tabId, { status: 'disconnected' })
        }
      }
    })
  }

  return { onConnect, push, getSnapshot, getServerSnapshot, onTabActivated }
}
