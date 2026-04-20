/**
 * Connection pool for wsClient instances, keyed by `wsUrl`.
 *
 * Spec §4.2 / plan Task 25:
 *  - Key is `wsUrl` (NOT active tab) — every tab pointing at the same daemon
 *    shares one WS.
 *  - Refcount per entry. Callers acquire on interest, release on loss of
 *    interest. When refcount reaches 0 the entry enters a `free` state.
 *  - Re-arm cooldown (default 1s): while the entry is free and within
 *    `reArmCooldownMs` of the last release, the next `acquire` reuses the
 *    existing client (refcount bumps, `build()` is not invoked). After the
 *    cooldown window elapses, the client is closed and the entry is dropped;
 *    a subsequent acquire builds a fresh client. This prevents WS churn when
 *    the last tab closes + a new tab re-subscribes within ~1s.
 *  - LRU cap (default 256). When a *brand-new* key is acquired and the pool
 *    would exceed the cap, the least-recently-used free entry is evicted
 *    (closed + dropped). If all entries are in use, the pool grows past the
 *    soft cap — callers should reduce concurrency.
 *
 * The pool has no `open()` side-effect; callers provide a `build` factory
 * and call `acquired.open()` themselves after acquire(). This keeps the pool
 * a pure bookkeeping structure.
 */

import type { WsClient } from './wsClient.js'

export interface ConnPool {
  acquire(wsUrl: string, build: () => WsClient): WsClient
  release(wsUrl: string): void
  get(wsUrl: string): WsClient | null
  size(): number
}

interface ConnEntry {
  client: WsClient
  refcount: number
  lastUsedAt: number
  lastFreedAt: number | null
}

const DEFAULT_MAX_SIZE = 256
const DEFAULT_REARM_COOLDOWN_MS = 1_000

export function createConnPool(opts?: {
  maxSize?: number
  reArmCooldownMs?: number
}): ConnPool {
  const maxSize = opts?.maxSize ?? DEFAULT_MAX_SIZE
  const reArmCooldownMs = opts?.reArmCooldownMs ?? DEFAULT_REARM_COOLDOWN_MS

  const entries = new Map<string, ConnEntry>()
  // Per-wsUrl creation lock: guards against re-entrant `acquire` calls for
  // the same key inside `build()`.
  const creating = new Set<string>()

  function isExpiredFree(entry: ConnEntry, now: number): boolean {
    return (
      entry.refcount === 0 &&
      entry.lastFreedAt !== null &&
      now - entry.lastFreedAt >= reArmCooldownMs
    )
  }

  function dropEntry(key: string, entry: ConnEntry): void {
    try {
      entry.client.close()
    } catch {
      // swallow
    }
    entries.delete(key)
  }

  function evictExpired(now: number): void {
    for (const [key, entry] of Array.from(entries)) {
      if (isExpiredFree(entry, now)) dropEntry(key, entry)
    }
  }

  function evictLruIfNeeded(now: number): void {
    if (entries.size < maxSize) return
    // Prefer evicting a free entry (refcount 0), least recently used first.
    let victimKey: string | null = null
    let victimLastUsed = Number.POSITIVE_INFINITY
    for (const [key, entry] of entries) {
      if (entry.refcount > 0) continue
      if (entry.lastUsedAt < victimLastUsed) {
        victimLastUsed = entry.lastUsedAt
        victimKey = key
      }
    }
    if (victimKey === null) {
      // All entries in use — cannot evict. Let the pool grow; callers should
      // reduce concurrency.
      return
    }
    const victim = entries.get(victimKey)
    if (victim !== undefined) dropEntry(victimKey, victim)
    // After eviction, harmless to also sweep any other expired frees.
    void now
  }

  return {
    acquire(wsUrl, build) {
      if (creating.has(wsUrl)) {
        throw new Error(`connPool: re-entrant acquire for ${wsUrl} inside build()`)
      }
      const now = Date.now()
      // Sweep expired free entries before any other work — keeps cooldown
      // semantics monotonic across calls.
      evictExpired(now)
      const existing = entries.get(wsUrl)
      if (existing !== undefined) {
        // Within cooldown: reuse the existing client (even if refcount was 0).
        existing.refcount += 1
        existing.lastUsedAt = now
        existing.lastFreedAt = null
        return existing.client
      }
      evictLruIfNeeded(now)
      creating.add(wsUrl)
      let client: WsClient
      try {
        client = build()
      } finally {
        creating.delete(wsUrl)
      }
      entries.set(wsUrl, {
        client,
        refcount: 1,
        lastUsedAt: now,
        lastFreedAt: null,
      })
      return client
    },

    release(wsUrl) {
      const entry = entries.get(wsUrl)
      if (entry === undefined) return
      entry.refcount -= 1
      if (entry.refcount > 0) return
      // Enter the free state. If the cooldown is zero, drop immediately.
      if (reArmCooldownMs <= 0) {
        dropEntry(wsUrl, entry)
        return
      }
      entry.lastFreedAt = Date.now()
    },

    get(wsUrl) {
      const entry = entries.get(wsUrl)
      return entry === undefined ? null : entry.client
    },

    size() {
      return entries.size
    },
  }
}
