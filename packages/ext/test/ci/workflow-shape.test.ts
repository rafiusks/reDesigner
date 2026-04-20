/**
 * Task 35 — CI workflow shape invariants.
 *
 * Asserts that the consolidated CI workflow carries all guards listed in the
 * v0 plan. Regex-based rather than YAML-parsed because `yaml` is not a
 * workspace dep and the workflow structure is stable — step names and flags
 * are the load-bearing contract here, not arbitrary YAML shape.
 *
 * Invariants checked:
 *  1. ext contract tests run in the same job as daemon tests (single runs-on,
 *     multiple steps including `pnpm -r run test` and the ext contract step)
 *  2. `pnpm why zod` OR an equivalent single-version guard step exists (the
 *     existing Task 31 step uses pnpm-lock grep; we accept either)
 *  3. logger redactor-pattern CI grep step exists, reading from
 *     .github/redactor-patterns.txt
 *  4. fidelity-diff triggers on PR changes to chromeMock/integration/chrome.*
 *  5. fake-timer deny-list grep step with 0-match expectation outside fixtures
 *  6. size-limit (or equivalent bash du) budget step on panel bundle
 *  7. leak-baseline.json mtime check fails if > 6 months stale
 *  8. nightly workflow exists with schedule + manual dispatch + e2e:nightly run
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..')
const ciPath = resolve(repoRoot, '.github/workflows/ci.yml')
const nightlyPath = resolve(repoRoot, '.github/workflows/nightly.yml')
const patternsPath = resolve(repoRoot, '.github/redactor-patterns.txt')

const ci = readFileSync(ciPath, 'utf8')

describe('CI workflow shape (Task 35)', () => {
  it('ext contract tests run in the same job as daemon tests (not a separate job)', () => {
    // The `test` job must contain both the recursive `pnpm -r run test` step
    // (which covers daemon+core+vite+ext unit) AND an explicit ext contract
    // step. Presence of the `Ext contract tests` step name under the same
    // `jobs.test:` block is the contract.
    const testJobMatch = ci.match(/\n {2}test:\n([\s\S]*?)(?=\n {2}[a-z][a-zA-Z_-]*:\n|\n\s*$)/)
    expect(testJobMatch, 'jobs.test block must exist').not.toBeNull()
    const testJob = testJobMatch?.[1] ?? ''
    expect(testJob).toMatch(/pnpm -r run test/)
    expect(testJob).toMatch(/Ext contract tests/)
    // No separate `ext-contract:` job (would violate same-job rule).
    expect(ci).not.toMatch(/\n {2}ext-contract:\n/)
  })

  it('zod single-version guard step exists', () => {
    // Either "pnpm why zod" output parsing or pnpm-lock single-version grep.
    const hasWhy = /pnpm why zod/.test(ci)
    const hasLockGuard = /Zod version single-major guard/.test(ci) && /pnpm-lock\.yaml/.test(ci)
    expect(hasWhy || hasLockGuard, 'expected pnpm why zod OR Zod single-major lockfile guard').toBe(
      true,
    )
  })

  it('redactor-pattern CI grep step exists and references .github/redactor-patterns.txt', () => {
    expect(ci).toMatch(/Redactor pattern guard/)
    expect(ci).toMatch(/\.github\/redactor-patterns\.txt/)
  })

  it('.github/redactor-patterns.txt exists and has at least one active pattern', () => {
    expect(existsSync(patternsPath)).toBe(true)
    const raw = readFileSync(patternsPath, 'utf8')
    const active = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'))
    expect(active.length).toBeGreaterThanOrEqual(2)
  })

  it('fidelity-diff job triggers on chromeMock, integration, and chrome.* additions in ext/src', () => {
    // Either a paths-filter job feeding a gated fidelity job, or an
    // unconditional fidelity step — we prefer gating and assert the gate.
    expect(ci).toMatch(/ext_chromeMock/)
    expect(ci).toMatch(/ext_integration/)
    expect(ci).toMatch(/packages\/ext\/test\/chromeMock\/\*\*/)
    expect(ci).toMatch(/packages\/ext\/test\/integration\/\*\*/)
    expect(ci).toMatch(/chrome\\\.|chrome\./) // grep for chrome. references
    expect(ci).toMatch(/fidelity\.test\.ts/)
  })

  it('fake-timer deny-list grep step exists with 0-match expectation outside fixtures', () => {
    expect(ci).toMatch(/[Ff]ake[- ]timer/)
    expect(ci).toMatch(/advanceTimersByTime/)
    expect(ci).toMatch(/runAllTimers/)
    expect(ci).toMatch(/setSystemTime/)
    // Must negate grep (exit 0 when no matches) AND exclude fixtures dir.
    expect(ci).toMatch(/!\s*grep|grep[^\n]*\|\|\s*true/)
    expect(ci).toMatch(/--exclude-dir=fixtures|test\/fixtures/)
  })

  it('size-limit / panel bundle budget step exists', () => {
    expect(ci).toMatch(/[Ss]ize[- ]limit|panel bundle size|panel.*bundle.*size/)
    // Must reference the panel bundle build output.
    expect(ci).toMatch(/panel/)
  })

  it('leak-baseline.json mtime staleness check exists (fails if > 6 months)', () => {
    expect(ci).toMatch(/leak-baseline\.json/)
    // 180 days = 6 months threshold.
    expect(ci).toMatch(/180/)
  })
})

describe('Nightly workflow (Task 35)', () => {
  it('nightly.yml exists', () => {
    expect(existsSync(nightlyPath)).toBe(true)
  })

  const nightly = existsSync(nightlyPath) ? readFileSync(nightlyPath, 'utf8') : ''

  it('runs e2e nightly harness with PW_FULL_HARNESS=1', () => {
    expect(nightly).toMatch(/test:e2e:nightly/)
    expect(nightly).toMatch(/PW_FULL_HARNESS:?\s*['"]?1/)
  })

  it('runs leak-baseline diff check', () => {
    expect(nightly).toMatch(/leak-baseline/)
  })

  it('has cron schedule (2am UTC) and manual dispatch trigger', () => {
    expect(nightly).toMatch(/schedule:/)
    expect(nightly).toMatch(/cron:\s*['"]0 2 \* \* \*['"]/)
    expect(nightly).toMatch(/workflow_dispatch/)
  })
})
