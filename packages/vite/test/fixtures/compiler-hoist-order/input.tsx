// @ts-nocheck
// Simulates React Compiler 1.0 hoisted-JSX output.
// In real compiled output, the cache array `_c` would be set up by the compiler runtime.
// This fixture hand-writes the hoisted form to confirm the Babel pass tolerates it.
const _c: unknown[] = []

export function Card() {
  _c[0] = <div className="card" />
  return _c[0]
}
