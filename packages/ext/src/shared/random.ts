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
