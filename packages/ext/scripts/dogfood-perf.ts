#!/usr/bin/env tsx
import { readFileSync } from 'node:fs'

interface PerfEntry {
  tabId: number
  pickSeq: number
  elapsedMs: number
  kind: 'ok' | 'fail'
  cold: boolean
}

const INPUT = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8')

// Accept two formats:
//  (a) chrome.storage.session dump — a JSON array of entries
//  (b) DevTools console "Save as" — one "[redesigner:perf] persistSelection {...}" per line
function parseEntries(raw: string): PerfEntry[] {
  const trimmed = raw.trim()
  // JSON array format starts with '[' immediately followed by '{' or whitespace+'{'.
  // Log lines start with '[redesigner:perf]' so a bare '[' check is ambiguous — use a
  // tighter heuristic: only treat as JSON when the first non-whitespace char after '[' is '{'.
  if (trimmed.startsWith('[') && /^\[\s*[{[]/.test(trimmed)) {
    return JSON.parse(trimmed) as PerfEntry[]
  }
  const lines = trimmed.split('\n').filter((l) => l.includes('[redesigner:perf]'))
  return lines.map((line) => {
    const braceIdx = line.indexOf('{')
    if (braceIdx === -1) throw new Error(`malformed perf line: ${line}`)
    return JSON.parse(line.slice(braceIdx)) as PerfEntry
  })
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx] ?? 0
}

const entries = parseEntries(INPUT).filter((e) => e.kind === 'ok')
const warm = entries
  .filter((e) => !e.cold)
  .map((e) => e.elapsedMs)
  .sort((a, b) => a - b)
const cold = entries
  .filter((e) => e.cold)
  .map((e) => e.elapsedMs)
  .sort((a, b) => a - b)

console.log(`warm N=${warm.length}, cold N=${cold.length}`)

let failed = false

// Warm gate: median < 150ms AND max < 500ms (requires N>=30 to be meaningful)
if (warm.length >= 30) {
  const med = percentile(warm, 0.5)
  const max = warm[warm.length - 1] ?? 0
  const p95 = percentile(warm, 0.95)
  console.log(`  warm median=${med}ms max=${max}ms p95=${p95}ms`)
  if (med >= 150) {
    console.error(`  FAIL: warm median ${med}ms >= 150ms`)
    failed = true
  }
  if (max >= 500) {
    console.error(`  FAIL: warm max ${max}ms >= 500ms`)
    failed = true
  }
} else {
  console.warn(`  warm sample too small (N=${warm.length} < 30) — gate skipped`)
}

// Cold gate: median < 1200ms AND at-most-2-of-20 exceed 3000ms (requires N>=20)
if (cold.length >= 20) {
  const med = percentile(cold, 0.5)
  const exceedCount = cold.filter((e) => e > 3000).length
  console.log(`  cold median=${med}ms exceed-3000=${exceedCount}/${cold.length}`)
  if (med >= 1200) {
    console.error(`  FAIL: cold median ${med}ms >= 1200ms`)
    failed = true
  }
  if (exceedCount > 2) {
    console.error(`  FAIL: cold exceed-3000 ${exceedCount} > 2`)
    failed = true
  }
} else {
  console.warn(`  cold sample too small (N=${cold.length} < 20) — gate skipped`)
}

process.exit(failed ? 1 : 0)
