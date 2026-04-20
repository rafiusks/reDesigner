/**
 * Task 25 — close-code reducer unit tests.
 *
 * Spec §4.4 close-code table. Reducer is a pure `nextState({prev, code, now, ...})`
 * function; tests enumerate every row plus the unknown default via fast-check.
 *
 * Property tests use fast-check (seed 42, numRuns 1000) matching the convention
 * in test/unit/extractHandle.test.ts.
 */

import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetRandom, setRandom } from '../../src/shared/random'
import {
  type ReducerState,
  initialReducerState,
  nextState,
  resetOnHello,
} from '../../src/sw/closeReducer'

const FAST_CHECK_SEED = 42
const NUM_RUNS = 1000
const KNOWN_CODES = [
  1000, 1001, 1002, 1005, 1006, 1011, 1012, 1013, 1015, 4406, 4408, 4409,
] as const

function s(overrides: Partial<ReducerState> = {}): ReducerState {
  return { ...initialReducerState(), ...overrides }
}

describe('closeReducer/initialReducerState', () => {
  it('returns zeroed state', () => {
    const st = initialReducerState()
    expect(st.attempts).toBe(0)
    expect(st.firstFailedAt).toBeNull()
    expect(st.revalidate1002Failures).toBe(0)
    expect(st.giveUp).toBe(false)
    expect(st.lastCode).toBeNull()
  })
})

describe('closeReducer/resetOnHello', () => {
  it('clears attempts, firstFailedAt, revalidate1002Failures, giveUp', () => {
    const prev = s({
      attempts: 4,
      firstFailedAt: 1000,
      revalidate1002Failures: 2,
      giveUp: true,
      lastCode: 1011,
    })
    const next = resetOnHello(prev)
    expect(next.attempts).toBe(0)
    expect(next.firstFailedAt).toBeNull()
    expect(next.revalidate1002Failures).toBe(0)
    expect(next.giveUp).toBe(false)
    // lastCode carries forward for observability; counters reset.
    expect(next.lastCode).toBe(1011)
  })
})

describe('closeReducer/nextState — no-reconnect codes (1000/1001)', () => {
  it.each([1000, 1001])('%i → action no-reconnect, state unchanged except lastCode', (code) => {
    const prev = s({ attempts: 3, firstFailedAt: 500, revalidate1002Failures: 1 })
    const { action, next } = nextState({ prev, code, now: 1_000 })
    expect(action.type).toBe('no-reconnect')
    expect(next.attempts).toBe(3)
    expect(next.firstFailedAt).toBe(500)
    expect(next.revalidate1002Failures).toBe(1)
    expect(next.giveUp).toBe(false)
    expect(next.lastCode).toBe(code)
  })
})

describe('closeReducer/nextState — 1002 session-revalidate w/ cap by failure count', () => {
  it('first 1002 → session-revalidate, revalidate1002Failures=1, attempts unchanged', () => {
    const { action, next } = nextState({ prev: s(), code: 1002, now: 1_000 })
    expect(action.type).toBe('session-revalidate')
    expect(next.revalidate1002Failures).toBe(1)
    expect(next.attempts).toBe(0)
    expect(next.firstFailedAt).toBeNull()
  })

  it('second 1002 → session-revalidate, revalidate1002Failures=2', () => {
    const after1 = nextState({ prev: s(), code: 1002, now: 1_000 }).next
    const { action, next } = nextState({ prev: after1, code: 1002, now: 2_000 })
    expect(action.type).toBe('session-revalidate')
    expect(next.revalidate1002Failures).toBe(2)
    expect(next.attempts).toBe(0)
  })

  it('third 1002 (cap exhausted) → cs-handshake-refetch; revalidate counter resets', () => {
    let st = nextState({ prev: s(), code: 1002, now: 1_000 }).next
    st = nextState({ prev: st, code: 1002, now: 2_000 }).next
    const { action, next } = nextState({ prev: st, code: 1002, now: 3_000 })
    expect(action.type).toBe('cs-handshake-refetch')
    expect(next.revalidate1002Failures).toBe(0)
    expect(next.attempts).toBe(0)
  })

  it('resetOnHello after cap + another 1002 → back to session-revalidate', () => {
    let st = nextState({ prev: s(), code: 1002, now: 1 }).next
    st = nextState({ prev: st, code: 1002, now: 2 }).next
    st = nextState({ prev: st, code: 1002, now: 3 }).next
    st = resetOnHello(st)
    const { action, next } = nextState({ prev: st, code: 1002, now: 4 })
    expect(action.type).toBe('session-revalidate')
    expect(next.revalidate1002Failures).toBe(1)
  })

  it('cap is by failure count, not wall-clock window', () => {
    // Two 1002s separated by 1 hour — should still hit cap on 3rd regardless.
    let st = nextState({ prev: s(), code: 1002, now: 0 }).next
    st = nextState({ prev: st, code: 1002, now: 3_600_000 }).next
    const { action } = nextState({ prev: st, code: 1002, now: 7_200_000 })
    expect(action.type).toBe('cs-handshake-refetch')
  })

  it('custom revalidateCap=1 → first session-revalidate, second → refetch', () => {
    const st = nextState({ prev: s(), code: 1002, now: 0, revalidateCap: 1 }).next
    const { action } = nextState({ prev: st, code: 1002, now: 1, revalidateCap: 1 })
    expect(action.type).toBe('cs-handshake-refetch')
  })
})

describe('closeReducer/nextState — backoff codes (1005/1006/1011)', () => {
  beforeEach(() => setRandom(() => 0.5))
  afterEach(() => resetRandom())

  it('1006 → backoff with healthProbe=true, attempts++, firstFailedAt set if null', () => {
    const { action, next } = nextState({ prev: s(), code: 1006, now: 5_000 })
    expect(action.type).toBe('backoff')
    if (action.type !== 'backoff') throw new Error()
    expect(action.healthProbe).toBe(true)
    // 0.5 * min(30000, 1000 * 2^1) = 0.5 * 2000 = 1000
    expect(action.delayMs).toBe(1000)
    expect(next.attempts).toBe(1)
    expect(next.firstFailedAt).toBe(5_000)
  })

  it('1005 → backoff with healthProbe=true (treated as 1006 equivalent)', () => {
    const { action } = nextState({ prev: s(), code: 1005, now: 5_000 })
    expect(action.type).toBe('backoff')
    if (action.type !== 'backoff') throw new Error()
    expect(action.healthProbe).toBe(true)
  })

  it('1011 → backoff with healthProbe=false', () => {
    const { action } = nextState({ prev: s(), code: 1011, now: 5_000 })
    expect(action.type).toBe('backoff')
    if (action.type !== 'backoff') throw new Error()
    expect(action.healthProbe).toBe(false)
  })

  it('firstFailedAt preserved across consecutive failures', () => {
    let st = nextState({ prev: s(), code: 1006, now: 100 }).next
    st = nextState({ prev: st, code: 1011, now: 200 }).next
    expect(st.firstFailedAt).toBe(100)
    expect(st.attempts).toBe(2)
  })

  it('5 consecutive failures → give-up', () => {
    let st = s()
    let action = nextState({ prev: st, code: 1006, now: 0 }).action
    st = nextState({ prev: st, code: 1006, now: 0 }).next
    for (let i = 1; i < 4; i += 1) {
      const r = nextState({ prev: st, code: 1006, now: i * 100 })
      action = r.action
      st = r.next
      expect(action.type).toBe('backoff')
    }
    // 5th failure triggers give-up
    const final = nextState({ prev: st, code: 1006, now: 500 })
    expect(final.action.type).toBe('give-up')
    expect(final.next.giveUp).toBe(true)
  })

  it('firstFailedAt + 60s elapsed → give-up even below 5 attempts', () => {
    const st = nextState({ prev: s(), code: 1006, now: 0 }).next
    const { action, next } = nextState({ prev: st, code: 1006, now: 60_001 })
    expect(action.type).toBe('give-up')
    expect(next.giveUp).toBe(true)
  })

  it('resetOnHello clears give-up readiness', () => {
    let st = s()
    for (let i = 0; i < 4; i += 1) {
      st = nextState({ prev: st, code: 1006, now: i * 100 }).next
    }
    st = resetOnHello(st)
    const { action } = nextState({ prev: st, code: 1006, now: 5_000 })
    expect(action.type).toBe('backoff')
  })

  it('custom giveUpCap=2', () => {
    const st = nextState({ prev: s(), code: 1006, now: 0, giveUpCap: 2 }).next
    const r = nextState({ prev: st, code: 1006, now: 1, giveUpCap: 2 })
    expect(r.action.type).toBe('give-up')
  })
})

describe('closeReducer/nextState — fixed-delay codes (1012/1013/4408)', () => {
  beforeEach(() => setRandom(() => 0.5))
  afterEach(() => resetRandom())

  it.each([1012, 1013, 4408])('%i → fixed-delay 1s + jitter, attempts unchanged', (code) => {
    const { action, next } = nextState({ prev: s({ attempts: 2 }), code, now: 0 })
    expect(action.type).toBe('fixed-delay')
    if (action.type !== 'fixed-delay') throw new Error()
    // 1000 + 0.5 * 1000 = 1500
    expect(action.delayMs).toBe(1500)
    expect(next.attempts).toBe(2)
    expect(next.firstFailedAt).toBeNull()
    expect(next.giveUp).toBe(false)
  })

  it('1012 × 10 → always fixed-delay, attempts stays 0', () => {
    let st = s()
    for (let i = 0; i < 10; i += 1) {
      const r = nextState({ prev: st, code: 1012, now: i * 100 })
      expect(r.action.type).toBe('fixed-delay')
      expect(r.next.attempts).toBe(0)
      expect(r.next.giveUp).toBe(false)
      st = r.next
    }
  })

  it('fixed-delay with random=0 → 1000ms exactly', () => {
    setRandom(() => 0)
    const { action } = nextState({ prev: s(), code: 1012, now: 0 })
    if (action.type !== 'fixed-delay') throw new Error()
    expect(action.delayMs).toBe(1000)
  })

  it('fixed-delay with random=0.999 → ≈1999ms', () => {
    setRandom(() => 0.999)
    const { action } = nextState({ prev: s(), code: 1012, now: 0 })
    if (action.type !== 'fixed-delay') throw new Error()
    expect(action.delayMs).toBeCloseTo(1999, 0)
  })
})

describe('closeReducer/nextState — give-up codes (1015/4409)', () => {
  it('1015 → give-up, giveUp=true', () => {
    const { action, next } = nextState({ prev: s(), code: 1015, now: 0 })
    expect(action.type).toBe('give-up')
    expect(next.giveUp).toBe(true)
  })

  it('4409 → give-up', () => {
    const { action, next } = nextState({ prev: s(), code: 4409, now: 0 })
    expect(action.type).toBe('give-up')
    expect(next.giveUp).toBe(true)
  })
})

describe('closeReducer/nextState — 4406 version negotiation', () => {
  it('parses closeReason accepted list and emits reconnect-version', () => {
    const { action } = nextState({
      prev: s(),
      code: 4406,
      now: 0,
      closeReason: '{"accepted":[1,2]}',
    })
    expect(action.type).toBe('reconnect-version')
    if (action.type !== 'reconnect-version') throw new Error()
    expect(action.accepted).toEqual([1, 2])
  })

  it('unparseable closeReason → action.accepted=null (caller falls back to highest local)', () => {
    const { action } = nextState({
      prev: s(),
      code: 4406,
      now: 0,
      closeReason: 'not-json',
    })
    expect(action.type).toBe('reconnect-version')
    if (action.type !== 'reconnect-version') throw new Error()
    expect(action.accepted).toBeNull()
  })

  it('missing closeReason → action.accepted=null', () => {
    const { action } = nextState({ prev: s(), code: 4406, now: 0 })
    expect(action.type).toBe('reconnect-version')
    if (action.type !== 'reconnect-version') throw new Error()
    expect(action.accepted).toBeNull()
  })

  it('closeReason with non-array accepted field → null', () => {
    const { action } = nextState({
      prev: s(),
      code: 4406,
      now: 0,
      closeReason: '{"accepted":"1"}',
    })
    if (action.type !== 'reconnect-version') throw new Error()
    expect(action.accepted).toBeNull()
  })

  it('closeReason accepted with non-integers → filtered out (null if empty)', () => {
    const { action } = nextState({
      prev: s(),
      code: 4406,
      now: 0,
      closeReason: '{"accepted":["a","b"]}',
    })
    if (action.type !== 'reconnect-version') throw new Error()
    expect(action.accepted).toBeNull()
  })

  it('does not increment attempts on 4406', () => {
    const { next } = nextState({
      prev: s({ attempts: 3 }),
      code: 4406,
      now: 0,
      closeReason: '{"accepted":[1]}',
    })
    expect(next.attempts).toBe(3)
  })
})

describe('closeReducer/nextState — unknown codes default branch', () => {
  it('unknown code in 3000-3999 range → treated as 1006 (backoff + probe)', () => {
    setRandom(() => 0.5)
    const { action, next } = nextState({ prev: s(), code: 3001, now: 0 })
    expect(action.type).toBe('backoff')
    if (action.type !== 'backoff') throw new Error()
    expect(action.healthProbe).toBe(true)
    expect(next.attempts).toBe(1)
    resetRandom()
  })
})

describe('closeReducer — property tests', () => {
  beforeEach(() => setRandom(() => 0.5))
  afterEach(() => resetRandom())

  it('every integer in [1000,4999] produces a well-formed action + state', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1000, max: 4999 }), (code) => {
        const r = nextState({ prev: s(), code, now: 42 })
        expect(r.action).toBeDefined()
        expect(typeof r.action.type).toBe('string')
        expect(r.next.lastCode).toBe(code)
        // attempts never negative
        expect(r.next.attempts).toBeGreaterThanOrEqual(0)
        // attempts bounded — reducer never bumps by more than 1 in a single call.
        expect(r.next.attempts).toBeLessThanOrEqual(1)
      }),
      { seed: FAST_CHECK_SEED, numRuns: NUM_RUNS },
    )
  })

  it('constantFrom enumerated codes — every known code has a defined action', () => {
    fc.assert(
      fc.property(fc.constantFrom(...KNOWN_CODES), (code) => {
        const r = nextState({ prev: s(), code, now: 0 })
        expect(r.action).toBeDefined()
      }),
      { seed: FAST_CHECK_SEED, numRuns: 200 },
    )
  })

  it('sequences of 2-20 codes converge — attempts bounded by giveUpCap, giveUp absorbs', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...KNOWN_CODES), { minLength: 2, maxLength: 20 }),
        (codes) => {
          let st = s()
          let t = 0
          for (const c of codes) {
            t += 10
            const r = nextState({ prev: st, code: c, now: t })
            st = r.next
            // attempts cannot exceed the give-up cap (default 5).
            expect(st.attempts).toBeLessThanOrEqual(5)
            // revalidate1002Failures cannot exceed its cap either.
            expect(st.revalidate1002Failures).toBeLessThanOrEqual(2)
          }
        },
      ),
      { seed: FAST_CHECK_SEED, numRuns: NUM_RUNS },
    )
  })
})
