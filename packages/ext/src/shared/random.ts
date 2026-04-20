import { BACKOFF_BASE_MS, BACKOFF_CAP_MS } from './constants'

export type Random = () => number

let current: Random = Math.random

export function setRandom(r: Random): void {
  current = r
}

export function resetRandom(): void {
  current = Math.random
}

export function nextFullJitterDelay(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new RangeError('attempts must be a non-negative integer')
  }
  const bound = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempts)
  return current() * bound
}

/**
 * "fixed base + jitter" delay (spec §4.4 for 1012/1013/4408).
 *
 * Value is always at least `baseMs` (no negative jitter) and at most
 * `baseMs + jitterMs`. Uses the same module-level random as
 * `nextFullJitterDelay` so tests can control it via `setRandom`.
 */
export function nextFixedDelay(baseMs: number, jitterMs: number): number {
  if (baseMs < 0 || jitterMs < 0 || !Number.isFinite(baseMs) || !Number.isFinite(jitterMs)) {
    throw new RangeError('baseMs and jitterMs must be non-negative finite numbers')
  }
  return baseMs + current() * jitterMs
}
