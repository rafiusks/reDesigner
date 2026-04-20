/**
 * Close-code reducer (spec §4.4).
 *
 * Pure function. Given the previous reducer state, a close code, and a
 * timestamp, compute the next action + state. No I/O, no timers — the caller
 * (`wsClient`) schedules reconnects based on the returned action.
 *
 * Action routing per spec §4.4:
 *
 *   | Code | Action                         | Budget? |
 *   | 1000 | no-reconnect                   | n/a     |
 *   | 1001 | no-reconnect                   | n/a     |
 *   | 1002 | session-revalidate (cap by     | cond.   |
 *   |      |   failure count, resets on     |         |
 *   |      |   hello); cap-exhaust →        |         |
 *   |      |   cs-handshake-refetch         |         |
 *   | 1005 | backoff + health probe         | yes     |
 *   | 1006 | backoff + health probe         | yes     |
 *   | 1011 | backoff + "Daemon error"       | yes     |
 *   | 1012 | fixed 1s + jitter              | no      |
 *   | 1013 | fixed 1s + jitter              | no      |
 *   | 1015 | give-up (TLS)                  | n/a     |
 *   | 4406 | reconnect-version; parse       | cond.   |
 *   |      |   {accepted:[...]}             |         |
 *   | 4408 | fixed 1s + jitter              | no      |
 *   | 4409 | give-up (reload required)      | n/a     |
 *   | else | treat as 1006                  | yes     |
 *
 * Give-up trigger (spec §4.4): 5 consecutive failures OR firstFailedAt+60s
 * elapsed, whichever first. Reset on hello via `resetOnHello`.
 *
 * Fixed-delay: spec says "fixed 1s + jitter". Implemented as
 * `1000 + random() * 1000` so the value is always at least 1s (no negative
 * jitter) and at most ~2s. The full-jitter path uses `nextFullJitterDelay`
 * from shared/random.ts.
 */

import { nextFixedDelay, nextFullJitterDelay } from '../shared/random.js'

export interface ReducerState {
  readonly attempts: number
  readonly firstFailedAt: number | null
  readonly revalidate1002Failures: number
  readonly giveUp: boolean
  readonly lastCode: number | null
}

export type ReducerAction =
  | { type: 'no-reconnect' }
  | { type: 'give-up' }
  | { type: 'session-revalidate' }
  | { type: 'cs-handshake-refetch' }
  | { type: 'backoff'; delayMs: number; healthProbe: boolean }
  | { type: 'fixed-delay'; delayMs: number }
  | { type: 'reconnect-version'; accepted: readonly number[] | null }

export interface NextStateArgs {
  prev: ReducerState
  code: number
  now: number
  closeReason?: string
  giveUpCap?: number
  giveUpWindowMs?: number
  revalidateCap?: number
}

export interface NextStateResult {
  readonly action: ReducerAction
  readonly next: ReducerState
}

const DEFAULT_GIVE_UP_CAP = 5
const DEFAULT_GIVE_UP_WINDOW_MS = 60_000
const DEFAULT_REVALIDATE_CAP = 2
const FIXED_DELAY_BASE_MS = 1_000
const FIXED_DELAY_JITTER_MS = 1_000

export function initialReducerState(): ReducerState {
  return {
    attempts: 0,
    firstFailedAt: null,
    revalidate1002Failures: 0,
    giveUp: false,
    lastCode: null,
  }
}

/**
 * Hello-success reset: zero all failure counters. `lastCode` carries forward
 * for observability (last observed close reason, if any).
 */
export function resetOnHello(state: ReducerState): ReducerState {
  return {
    attempts: 0,
    firstFailedAt: null,
    revalidate1002Failures: 0,
    giveUp: false,
    lastCode: state.lastCode,
  }
}

function parseAcceptedVersions(reason: string | undefined): readonly number[] | null {
  if (reason === undefined || reason.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(reason)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const accepted = (parsed as { accepted?: unknown }).accepted
  if (!Array.isArray(accepted)) return null
  const filtered = accepted.filter((v): v is number => Number.isInteger(v))
  return filtered.length > 0 ? filtered : null
}

function shouldGiveUp(args: {
  attempts: number
  firstFailedAt: number | null
  now: number
  cap: number
  windowMs: number
}): boolean {
  if (args.attempts >= args.cap) return true
  if (args.firstFailedAt !== null && args.now - args.firstFailedAt >= args.windowMs) return true
  return false
}

export function nextState(args: NextStateArgs): NextStateResult {
  const {
    prev,
    code,
    now,
    closeReason,
    giveUpCap = DEFAULT_GIVE_UP_CAP,
    giveUpWindowMs = DEFAULT_GIVE_UP_WINDOW_MS,
    revalidateCap = DEFAULT_REVALIDATE_CAP,
  } = args

  // Once give-up latches, the reducer is idempotent: subsequent close codes
  // do not advance any counters. The caller is expected to stop reconnecting
  // until `resetOnHello` is applied.
  if (prev.giveUp) {
    return {
      action: { type: 'give-up' },
      next: {
        attempts: prev.attempts,
        firstFailedAt: prev.firstFailedAt,
        revalidate1002Failures: prev.revalidate1002Failures,
        giveUp: true,
        lastCode: code,
      },
    }
  }

  const carry: Pick<ReducerState, 'attempts' | 'firstFailedAt' | 'revalidate1002Failures'> = {
    attempts: prev.attempts,
    firstFailedAt: prev.firstFailedAt,
    revalidate1002Failures: prev.revalidate1002Failures,
  }

  const baseNext = (overrides: Partial<ReducerState> = {}): ReducerState => ({
    attempts: carry.attempts,
    firstFailedAt: carry.firstFailedAt,
    revalidate1002Failures: carry.revalidate1002Failures,
    giveUp: false,
    lastCode: code,
    ...overrides,
  })

  // ---- no-reconnect codes -------------------------------------------------
  if (code === 1000 || code === 1001) {
    return {
      action: { type: 'no-reconnect' },
      next: baseNext(),
    }
  }

  // ---- give-up codes ------------------------------------------------------
  if (code === 1015 || code === 4409) {
    return {
      action: { type: 'give-up' },
      next: baseNext({ giveUp: true }),
    }
  }

  // ---- 1002 session-revalidate -------------------------------------------
  if (code === 1002) {
    if (prev.revalidate1002Failures < revalidateCap) {
      return {
        action: { type: 'session-revalidate' },
        next: baseNext({ revalidate1002Failures: prev.revalidate1002Failures + 1 }),
      }
    }
    // Cap exhausted: route to CS handshake refetch + re-exchange. Reset the
    // revalidate counter so a subsequent hello/failure starts the cycle over.
    return {
      action: { type: 'cs-handshake-refetch' },
      next: baseNext({ revalidate1002Failures: 0 }),
    }
  }

  // ---- 4406 version negotiation ------------------------------------------
  if (code === 4406) {
    const accepted = parseAcceptedVersions(closeReason)
    return {
      action: { type: 'reconnect-version', accepted },
      next: baseNext(),
    }
  }

  // ---- fixed-delay codes --------------------------------------------------
  if (code === 1012 || code === 1013 || code === 4408) {
    const delayMs = nextFixedDelay(FIXED_DELAY_BASE_MS, FIXED_DELAY_JITTER_MS)
    return {
      action: { type: 'fixed-delay', delayMs },
      next: baseNext(),
    }
  }

  // ---- backoff codes (1005, 1006, 1011, and unknown default) --------------
  // Default branch (spec §4.4): unknown codes are treated as 1006-equivalent.
  const healthProbe = code !== 1011 // 1005/1006 and unknown default → probe; 1011 → no probe
  const attempts = prev.attempts + 1
  const firstFailedAt = prev.firstFailedAt ?? now
  if (shouldGiveUp({ attempts, firstFailedAt, now, cap: giveUpCap, windowMs: giveUpWindowMs })) {
    return {
      action: { type: 'give-up' },
      next: {
        attempts,
        firstFailedAt,
        revalidate1002Failures: prev.revalidate1002Failures,
        giveUp: true,
        lastCode: code,
      },
    }
  }
  const delayMs = nextFullJitterDelay(attempts)
  return {
    action: { type: 'backoff', delayMs, healthProbe },
    next: {
      attempts,
      firstFailedAt,
      revalidate1002Failures: prev.revalidate1002Failures,
      giveUp: false,
      lastCode: code,
    },
  }
}
