/**
 * Per-wsUrl manifest cache (spec §4.3 / Task 27).
 *
 * Properties:
 *  - Single-flight: concurrent get() calls for the same wsUrl share one
 *    in-flight fetch rather than spawning duplicates.
 *  - Seq-tagged atomic swap: each fetch captures the seq value before
 *    awaiting. On completion, if the seq has changed (invalidate or a racing
 *    newer fetch) the result is discarded — stale writes are not committed.
 *  - Wake-safe promise reset: resetAll() clears in-flight promise references
 *    (stale promises from a previous SW life should not fulfill into the new
 *    wake's cache). Resolved manifests are kept so post-wake reads still hit
 *    the cache; a fresh fetch starts on the next get() if needed.
 *
 * CLAUDE.md invariants honoured:
 *  - No module-level side effects.
 *  - Zod schemas at module top-level where present.
 */

import type { Manifest } from '@redesigner/core'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ManifestCache {
  /**
   * Return the manifest for the given wsUrl.
   *
   * If a cached manifest is present, returns immediately. If a fetch is
   * already in-flight, joins it (single-flight). Otherwise starts a new
   * fetch using the provided `fetcher` (or the default `fetchManifest`
   * supplied at construction time).
   */
  get(wsUrl: string, opts?: { fetcher?: () => Promise<Manifest> }): Promise<Manifest>
  /**
   * Bump the seq for this wsUrl and clear both manifest and in-flight promise.
   * Any concurrent fetch will detect the seq bump and discard its result.
   */
  invalidate(wsUrl: string): void
  /**
   * Clear ALL in-flight promises (wake-safe reset called on hydrate).
   * Resolved manifests are retained so the next get() can return them
   * immediately; if the caller wants stale data gone it should call invalidate()
   * per-url before resetAll().
   */
  resetAll(): void
  /** Current seq for the given wsUrl (0 if never seen). */
  seq(wsUrl: string): number
}

// ---------------------------------------------------------------------------
// Internal state per url
// ---------------------------------------------------------------------------

interface CacheEntry {
  /** Resolved manifest or null if not yet fetched / invalidated. */
  manifest: Manifest | null
  /**
   * In-flight promise. null when no fetch is in progress.
   * resetAll() clears this so stale cross-wake promises are dropped.
   */
  promise: Promise<Manifest> | null
  /**
   * Monotonic integer. Bumped on invalidate() and before each new fetch so
   * concurrent fetches can detect staleness.
   */
  seq: number
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createManifestCache(opts?: {
  fetchManifest?: (wsUrl: string) => Promise<Manifest>
}): ManifestCache {
  const defaultFetch =
    opts?.fetchManifest ??
    (async (_wsUrl: string): Promise<Manifest> => {
      throw new Error('manifestCache: no fetchManifest provided')
    })

  const entries = new Map<string, CacheEntry>()

  function getOrCreate(wsUrl: string): CacheEntry {
    let entry = entries.get(wsUrl)
    if (entry === undefined) {
      entry = { manifest: null, promise: null, seq: 0 }
      entries.set(wsUrl, entry)
    }
    return entry
  }

  return {
    get(wsUrl: string, callOpts?: { fetcher?: () => Promise<Manifest> }): Promise<Manifest> {
      const entry = getOrCreate(wsUrl)

      // Cache hit — return immediately.
      if (entry.manifest !== null) {
        return Promise.resolve(entry.manifest)
      }

      // Single-flight — join the existing in-flight promise.
      if (entry.promise !== null) {
        return entry.promise
      }

      // Start a new fetch. Capture seq before the async work; the write
      // after await is only committed if seq hasn't changed (no invalidate
      // or a racing newer fetch bumped it).
      const fetcher = callOpts?.fetcher ?? (() => defaultFetch(wsUrl))

      // Increment seq to tag this fetch attempt.
      const expectedSeq = ++entry.seq

      const promise: Promise<Manifest> = (async () => {
        try {
          const manifest = await fetcher()
          // If seq is still the value we set, no invalidation raced us — commit.
          if (entry.seq === expectedSeq) {
            entry.manifest = manifest
            entry.promise = null
          }
          return manifest
        } catch (err) {
          // On error, clear the promise so the next get() retries.
          if (entry.seq === expectedSeq) {
            entry.promise = null
          }
          throw err
        }
      })()

      entry.promise = promise
      return promise
    },

    invalidate(wsUrl: string): void {
      const entry = getOrCreate(wsUrl)
      entry.seq += 1
      entry.manifest = null
      entry.promise = null
    },

    resetAll(): void {
      for (const entry of entries.values()) {
        // Keep resolved manifests so post-wake reads still hit the cache.
        // Clear in-flight promises — they belong to a previous SW life and
        // their callbacks may reference stale closures.
        entry.promise = null
      }
    },

    seq(wsUrl: string): number {
      return entries.get(wsUrl)?.seq ?? 0
    },
  }
}
