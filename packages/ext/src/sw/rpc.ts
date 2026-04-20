/**
 * RPC manager for in-flight requests (spec §4.3).
 *
 * Responsibilities:
 *  - Persist inFlight entries synchronously on insertion (awaited before
 *    returning) and synchronously cleared on resolve/deadline.
 *  - Monotonic counter for picking RPCs.
 *  - Grace window: min(15s, max(3s, now - sw.wakeAt)) to prevent false
 *    disarm during SW wake.
 *  - Result envelope {truncated, partial, fullBytes} for >512KB payloads.
 *  - sweepPastDeadline returns entries older than deadlineAt; caller emits
 *    synthetic timeout replies via WS upstream (daemon forwards to MCP) —
 *    NOT via chrome.runtime.sendMessage (can't reach Node).
 *
 * CLAUDE.md invariants honoured:
 *  - Zod schemas at module top-level (100x v4 regression cliff).
 *  - No module-level side effects.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InFlightRpc {
  readonly id: string
  readonly method: string
  readonly startedAt: number
  readonly deadlineAt: number
  /** Monotonic pick / rpc counter at time of insertion. */
  readonly counter: number
  readonly clientId?: string
  readonly tabId?: number
}

export interface ResultEnvelope {
  readonly truncated: boolean
  /** Present only when truncated. Slice of JSON-serialized result up to maxResultBytes. */
  readonly partial?: string
  /** Present only when truncated. Full serialized byte length. */
  readonly fullBytes?: number
  /** Present only when not truncated. The original result value. */
  readonly value?: unknown
}

export interface RpcManager {
  /** Insert an in-flight RPC and await persist before returning. */
  insert(rpc: InFlightRpc): Promise<void>
  /**
   * Resolve an in-flight RPC. Returns the result envelope (possibly truncated).
   * Removes the entry from inFlight and persists synchronously.
   */
  resolve(id: string, result: unknown): Promise<ResultEnvelope>
  /** Reject an in-flight RPC. Removes the entry and persists synchronously. */
  reject(id: string, error: { code: string; message: string }): Promise<void>
  /**
   * Returns entries with deadlineAt < now. Caller is responsible for emitting
   * synthetic 'extension-timeout' replies over the WS upstream.
   * Entries are removed from inFlight and persisted.
   */
  sweepPastDeadline(now: number): Promise<readonly InFlightRpc[]>
  /**
   * Grace window for SW wake: min(15s, max(3s, now - wakeAt)).
   * Prevents false disarm of pickerArmed heartbeat during SW wake.
   */
  graceWindowMs(now: number): number
  /** Monotonically increasing counter, starting at 0. */
  nextCounter(): number
  /** Snapshot of current in-flight entries. */
  current(): readonly InFlightRpc[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RESULT_BYTES = 512 * 1024 // 512 KB
const GRACE_MIN_MS = 3_000
const GRACE_MAX_MS = 15_000

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRpcManager(opts?: {
  now?: () => number
  wakeAt?: number
  persist?: (list: readonly InFlightRpc[]) => Promise<void>
  maxResultBytes?: number
}): RpcManager {
  const now = opts?.now ?? (() => Date.now())
  const wakeAt = opts?.wakeAt ?? 0
  const persist = opts?.persist ?? (async () => undefined)
  const maxResultBytes = opts?.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES

  // In-memory list. Map preserves insertion order.
  const inFlight = new Map<string, InFlightRpc>()
  let counter = 0

  function snapshot(): readonly InFlightRpc[] {
    return Array.from(inFlight.values())
  }

  async function persistCurrent(): Promise<void> {
    await persist(snapshot())
  }

  function buildEnvelope(result: unknown): ResultEnvelope {
    const serialized = JSON.stringify(result)
    const byteLength = new TextEncoder().encode(serialized).byteLength
    if (byteLength > maxResultBytes) {
      // Truncate at maxResultBytes characters (UTF-16 units). For the partial
      // slice we use character index rather than byte index because the caller
      // wants a valid-ish JSON prefix. Slight overcount for multibyte chars is
      // acceptable — this is an overflow signal, not a strict cut.
      const partial = serialized.slice(0, maxResultBytes)
      return { truncated: true, partial, fullBytes: byteLength }
    }
    return { truncated: false, value: result }
  }

  return {
    async insert(rpc: InFlightRpc): Promise<void> {
      inFlight.set(rpc.id, rpc)
      await persistCurrent()
    },

    async resolve(id: string, result: unknown): Promise<ResultEnvelope> {
      const envelope = buildEnvelope(result)
      inFlight.delete(id)
      await persistCurrent()
      return envelope
    },

    async reject(id: string, _error: { code: string; message: string }): Promise<void> {
      inFlight.delete(id)
      await persistCurrent()
    },

    async sweepPastDeadline(nowMs: number): Promise<readonly InFlightRpc[]> {
      const expired: InFlightRpc[] = []
      for (const entry of inFlight.values()) {
        if (entry.deadlineAt < nowMs) {
          expired.push(entry)
        }
      }
      for (const entry of expired) {
        inFlight.delete(entry.id)
      }
      if (expired.length > 0) {
        await persistCurrent()
      }
      return expired
    },

    graceWindowMs(nowMs: number): number {
      return Math.min(GRACE_MAX_MS, Math.max(GRACE_MIN_MS, nowMs - wakeAt))
    },

    nextCounter(): number {
      const c = counter
      counter += 1
      return c
    },

    current(): readonly InFlightRpc[] {
      return snapshot()
    },
  }
}
