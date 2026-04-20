export interface TokenBucket {
  tryConsume(): boolean
  retryAfterSec(): number
}

export function createTokenBucket(opts: { ratePerSec: number; burst: number }): TokenBucket {
  let tokens = opts.burst
  let lastRefill = Date.now()
  const refill = () => {
    const now = Date.now()
    const elapsed = (now - lastRefill) / 1000
    tokens = Math.min(opts.burst, tokens + elapsed * opts.ratePerSec)
    lastRefill = now
  }
  return {
    tryConsume() {
      refill()
      if (tokens >= 1) {
        tokens -= 1
        return true
      }
      return false
    },
    retryAfterSec() {
      refill()
      return Math.max(1, Math.ceil((1 - tokens) / opts.ratePerSec))
    },
  }
}

export interface ConcurrencyGate {
  acquire(): boolean
  release(): void
  inFlight(): number
}

export function createConcurrencyGate(limit: number): ConcurrencyGate {
  let active = 0
  return {
    acquire() {
      if (active >= limit) return false
      active++
      return true
    },
    release() {
      if (active > 0) active--
    },
    inFlight() {
      return active
    },
  }
}
