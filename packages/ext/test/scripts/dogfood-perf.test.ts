import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

describe('dogfood-perf CI gate', () => {
  test('committed fixture passes the gate', () => {
    const fixture = resolve(import.meta.dirname, '../fixtures/dogfood-perf-sample.log')
    expect(() => {
      execFileSync('tsx', ['scripts/dogfood-perf.ts', fixture], {
        cwd: resolve(import.meta.dirname, '../..'),
        stdio: 'pipe',
      })
    }).not.toThrow()
  })

  test('negative case: a fixture exceeding the gate fails', () => {
    // 30 warm entries all at 500ms — median 500ms exceeds the 150ms budget.
    const lines: string[] = []
    for (let i = 1; i <= 30; i++) {
      const entry = { tabId: 1001, pickSeq: i, elapsedMs: 500, kind: 'ok', cold: false }
      lines.push(`[redesigner:perf] persistSelection ${JSON.stringify(entry)}`)
    }
    // 20 cold entries all at 4000ms — median 4000ms exceeds 1200ms and all exceed 3000ms.
    for (let i = 1; i <= 20; i++) {
      const entry = { tabId: 1001, pickSeq: 30 + i, elapsedMs: 4000, kind: 'ok', cold: true }
      lines.push(`[redesigner:perf] persistSelection ${JSON.stringify(entry)}`)
    }
    const tmpDir = mkdtempSync(join(tmpdir(), 'dogfood-perf-neg-'))
    const fixturePath = join(tmpDir, 'failing.log')
    writeFileSync(fixturePath, lines.join('\n'))

    expect(() => {
      execFileSync('tsx', ['scripts/dogfood-perf.ts', fixturePath], {
        cwd: resolve(import.meta.dirname, '../..'),
        stdio: 'pipe',
      })
    }).toThrow()
  })
})
