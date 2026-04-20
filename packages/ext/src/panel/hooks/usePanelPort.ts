/**
 * usePanelPort — React 19 hook bridging a `chrome.runtime.Port` into a
 * `useSyncExternalStore` external store, one snapshot per
 * `(windowId, tabId)` pair.
 *
 * Invariants (Task 29, see ../../../docs/0.1.0-v0-plan.md §Task 29):
 *  - `getSnapshot()` / `getServerSnapshot()` return Object.is-identical refs
 *    until a real mutation arrives (push from SW, port disconnect, or
 *    explicit version bump). React concurrent mode tears without this.
 *  - `getServerSnapshot` is supplied, not omitted — SSR-style `renderToString`
 *    of the panel throws otherwise (this is what Task 30's fixture snapshot
 *    will exercise).
 *  - `WINDOW_ID_NONE` (or tabId < 0) short-circuits: no port opens, a stable
 *    empty snapshot is returned. This happens on initial panel mount before
 *    `chrome.tabs.query` resolves — opening a port against the wrong key
 *    would wedge the SW's per-key cache.
 *  - When the port disconnects, the snapshot transitions to a dimmed
 *    `'resync'` transient status; UI renders `data-resync="true"` on root so
 *    CSS can drop opacity without re-triggering a skeleton. The hook then
 *    transparently reconnects on the next mount cycle or on the next message
 *    over a new port (SW re-sends on `runtime.onConnect`).
 *  - Module imports restrict to type-only — specifically NO `zod` runtime.
 *    The panel bundle must stay Zod-free; frames arriving from the SW have
 *    already been validated on that side.
 */

import type { ComponentHandle } from '@redesigner/core/types'
import { useCallback, useSyncExternalStore } from 'react'

export const WINDOW_ID_NONE = -1

export type PanelStatus = 'hydrating' | 'connected' | 'disconnected' | 'mcp-missing' | 'resync'

export interface PanelPortHookSnapshot {
  readonly status: PanelStatus
  readonly tabId: number
  readonly windowId: number
  readonly selection: ComponentHandle | null
  readonly pickerArmed: boolean
  readonly recent: readonly ComponentHandle[]
  readonly version: number
  /** Origin of the tab the panel is attached to once the CS has registered. */
  readonly serverUrl: string | null
}

interface PushSnapshotMessage {
  readonly type: 'snapshot'
  readonly snapshot: PanelPortHookSnapshot
}

// ---------------------------------------------------------------------------
// Module-level store. One entry per (windowId, tabId) key.
// ---------------------------------------------------------------------------

interface StoreEntry {
  snapshot: PanelPortHookSnapshot
  listeners: Set<() => void>
  port: chrome.runtime.Port | null
  /** Ref count from `subscribe()` — we close the port when it drops to 0. */
  refCount: number
}

export type ConnectFn = () => chrome.runtime.Port

const entries = new Map<string, StoreEntry>()

function makeKey(windowId: number, tabId: number): string {
  return `${windowId}:${tabId}`
}

function makeDefaultSnapshot(windowId: number, tabId: number): PanelPortHookSnapshot {
  return Object.freeze({
    status: 'hydrating' as const,
    tabId,
    windowId,
    selection: null,
    pickerArmed: false,
    recent: Object.freeze([]) as readonly ComponentHandle[],
    version: 0,
    serverUrl: null,
  })
}

function getOrCreateEntry(windowId: number, tabId: number): StoreEntry {
  const key = makeKey(windowId, tabId)
  let entry = entries.get(key)
  if (!entry) {
    entry = {
      snapshot: makeDefaultSnapshot(windowId, tabId),
      listeners: new Set(),
      port: null,
      refCount: 0,
    }
    entries.set(key, entry)
  }
  return entry
}

function notify(entry: StoreEntry): void {
  for (const fn of entry.listeners) fn()
}

/** Replace the cached snapshot and notify. Bumps version. */
function applySnapshot(
  windowId: number,
  tabId: number,
  partial: Partial<Omit<PanelPortHookSnapshot, 'tabId' | 'windowId' | 'version'>>,
): void {
  const entry = getOrCreateEntry(windowId, tabId)
  const next: PanelPortHookSnapshot = Object.freeze({
    ...entry.snapshot,
    ...partial,
    tabId,
    windowId,
    version: entry.snapshot.version + 1,
  })
  entry.snapshot = next
  notify(entry)
}

function isPushSnapshotMessage(m: unknown): m is PushSnapshotMessage {
  if (typeof m !== 'object' || m === null) return false
  const o = m as { type?: unknown; snapshot?: unknown }
  if (o.type !== 'snapshot') return false
  if (typeof o.snapshot !== 'object' || o.snapshot === null) return false
  const s = o.snapshot as Record<string, unknown>
  return typeof s.tabId === 'number' && typeof s.windowId === 'number'
}

function openPort(windowId: number, tabId: number, entry: StoreEntry, connect: ConnectFn): void {
  if (entry.port) return
  const port = connect()
  entry.port = port

  // The panel's chrome.runtime.connect({name:'panel'}) produces a port whose
  // `sender.tab` is undefined on the SW side (the panel isn't a tab). Send an
  // explicit hello so the SW can key the snapshot cache correctly and push
  // the initial snapshot back.
  try {
    port.postMessage({ type: 'panel-hello', windowId, tabId })
  } catch {
    // Port may disconnect between creation and first postMessage on slow hosts;
    // the onDisconnect handler below schedules a reconnect via microtask.
  }

  port.onMessage.addListener((raw) => {
    if (!isPushSnapshotMessage(raw)) return
    const snap = raw.snapshot
    // Discard snapshots for other keys — guards against a wedged SW pushing
    // cross-tab state into our store.
    if (snap.windowId !== windowId || snap.tabId !== tabId) return
    applySnapshot(windowId, tabId, {
      status: snap.status,
      selection: snap.selection,
      pickerArmed: snap.pickerArmed,
      recent: snap.recent,
      serverUrl: snap.serverUrl,
    })
  })

  port.onDisconnect.addListener(() => {
    const e = entries.get(makeKey(windowId, tabId))
    if (!e) return
    e.port = null
    applySnapshot(windowId, tabId, { status: 'resync' })
    // Reconnect only if subscribers are still around. Defer so we exit the
    // current disconnect callback (and the React render it schedules) before
    // registering fresh listeners on a new port. The SW's onConnect handler
    // will push a fresh snapshot, flipping us back to 'connected'.
    if (e.refCount > 0) {
      queueMicrotask(() => {
        const latest = entries.get(makeKey(windowId, tabId))
        if (!latest || latest.port || latest.refCount === 0) return
        try {
          openPort(windowId, tabId, latest, connect)
        } catch {
          // Swallow — SW may be restarting. Next subscribe() wake will retry.
        }
      })
    }
  })
}

function closePortIfIdle(entry: StoreEntry): void {
  if (entry.refCount > 0 || !entry.port) return
  try {
    entry.port.disconnect()
  } catch {
    // ignore — port may already be gone
  }
  entry.port = null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getPanelSnapshot(windowId: number, tabId: number): PanelPortHookSnapshot {
  return getOrCreateEntry(windowId, tabId).snapshot
}

export interface UsePanelPortArgs {
  windowId: number
  tabId: number
  /** Override for tests; defaults to `chrome.runtime.connect({name:'panel'})`. */
  connect?: ConnectFn
}

function defaultConnect(): chrome.runtime.Port {
  return chrome.runtime.connect({ name: 'panel' })
}

export function usePanelPort(args: UsePanelPortArgs): PanelPortHookSnapshot {
  const { windowId, tabId } = args
  const connect = args.connect ?? defaultConnect

  // subscribe and getSnap MUST be referentially stable across renders for a
  // given (windowId, tabId) — useSyncExternalStore re-runs subscribe on every
  // identity change, which would thrash the port and in StrictMode produce
  // "Maximum update depth exceeded".
  const subscribe = useCallback(
    (listener: () => void): (() => void) => {
      const enabled = windowId !== WINDOW_ID_NONE && tabId >= 0
      const entry = getOrCreateEntry(windowId, tabId)
      entry.listeners.add(listener)
      if (!enabled) {
        return () => {
          entry.listeners.delete(listener)
        }
      }
      entry.refCount += 1
      if (!entry.port) {
        try {
          openPort(windowId, tabId, entry, connect)
        } catch {
          // SW asleep or reload in progress — onDisconnect path will retry.
        }
      }
      return () => {
        entry.listeners.delete(listener)
        entry.refCount = Math.max(0, entry.refCount - 1)
        if (entry.refCount === 0) closePortIfIdle(entry)
      }
    },
    [windowId, tabId, connect],
  )

  const getSnap = useCallback(
    (): PanelPortHookSnapshot => getPanelSnapshot(windowId, tabId),
    [windowId, tabId],
  )

  // getServerSnapshot MUST be provided (not omitted) — see
  // https://react.dev/reference/react/useSyncExternalStore#parameters. We
  // pass `getSnap` as both so the hydration-time and CSR reads agree.
  return useSyncExternalStore(subscribe, getSnap, getSnap)
}

// ---------------------------------------------------------------------------
// Test-only. Not exported from the package barrel.
// ---------------------------------------------------------------------------

export function __resetPanelStoreForTests(): void {
  for (const entry of entries.values()) {
    if (entry.port) {
      try {
        entry.port.disconnect()
      } catch {
        // ignore
      }
    }
    entry.listeners.clear()
  }
  entries.clear()
}
