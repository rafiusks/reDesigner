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
  /** Tab origin once the CS registers — drives the Welcome component copy. */
  readonly serverUrl: string | null
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
    serverUrl: null,
  }
}

export function createPanelPort(): PanelPort {
  const cache = new Map<string, PanelSnapshot>()
  const ports = new Map<string, chrome.runtime.Port>()

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
    // If a panel is currently subscribed for this (window, tab), forward the
    // new snapshot. postMessage throws synchronously on a disconnected port —
    // swallow so callers don't need to care about race conditions.
    const openPort = ports.get(key)
    if (openPort) {
      try {
        openPort.postMessage({ type: 'snapshot', snapshot: next })
      } catch {
        ports.delete(key)
      }
    }
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
    // Side panels don't populate `port.sender.tab` (the panel isn't a tab).
    // Wait for the panel's `panel-hello` init message, which carries the
    // windowId/tabId the panel resolved from its URL + chrome.tabs.query.
    let windowId: number | undefined
    let tabId: number | undefined

    port.onMessage.addListener((raw) => {
      if (
        typeof raw === 'object' &&
        raw !== null &&
        (raw as { type?: unknown }).type === 'panel-hello'
      ) {
        const hello = raw as { windowId?: unknown; tabId?: unknown }
        if (typeof hello.windowId === 'number' && typeof hello.tabId === 'number') {
          windowId = hello.windowId
          tabId = hello.tabId
          ports.set(makeKey(windowId, tabId), port)
          // Bump version so the skeleton clears (panel's isSkeleton guard is
          // `status === 'hydrating' && version === 0`). push() will forward
          // the new snapshot to this port via the `ports` map.
          push(windowId, tabId, { status: 'connected' })
        }
      }
    })

    port.onDisconnect.addListener(() => {
      if (windowId !== undefined && tabId !== undefined) {
        const key = makeKey(windowId, tabId)
        ports.delete(key)
        const current = cache.get(key)
        if (current) {
          push(windowId, tabId, { status: 'disconnected' })
        }
      }
    })
  }

  return { onConnect, push, getSnapshot, getServerSnapshot, onTabActivated }
}
