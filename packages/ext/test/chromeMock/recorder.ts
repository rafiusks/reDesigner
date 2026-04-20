/**
 * Central side-effect recorder shared across all namespace mocks.
 *
 * Records an unordered multiset of {type, args} entries. Timestamps are
 * captured but excluded from the fidelity diff (per spec §8.1).
 */

export interface SideEffect {
  readonly type: string
  readonly args: unknown
  readonly ts?: number
}

export interface SideEffectRecorder {
  readonly record: (e: Omit<SideEffect, 'ts'>) => void
  readonly snapshot: () => readonly SideEffect[]
  readonly clear: () => void
}

export function makeRecorder(clock: () => number = Date.now): SideEffectRecorder {
  const effects: SideEffect[] = []
  return {
    record({ type, args }) {
      effects.push({ type, args: structuredClone(args), ts: clock() })
    },
    snapshot() {
      return [...effects]
    },
    clear() {
      effects.length = 0
    },
  }
}
