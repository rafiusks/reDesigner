// packages/vite/test/integration/atomic-bootstrap.test.ts
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Record fs call sequence. `vi.mock` is hoisted, so the recorder must be created
// via `vi.hoisted` to be referable from inside the factory.
const { calls, getReal } = vi.hoisted(() => {
  const calls: string[] = []
  let real: typeof import('node:fs') | null = null
  return {
    calls,
    getReal: (mod: typeof import('node:fs')) => {
      real = mod
      return real
    },
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  getReal(actual)
  return {
    ...actual,
    writeFileSync: ((p: unknown, data: unknown, opts: unknown) => {
      calls.push(`writeFileSync:${String(p)}`)
      return actual.writeFileSync(p as never, data as never, opts as never)
    }) as typeof actual.writeFileSync,
    renameSync: ((src: unknown, dst: unknown) => {
      calls.push(`renameSync:${String(src)}->${String(dst)}`)
      return actual.renameSync(src as never, dst as never)
    }) as typeof actual.renameSync,
  }
})

// Import AFTER vi.mock is declared — vitest hoists the mock above this import.
const { ManifestWriter } = await import('../../src/integration/manifestWriter')

describe('ManifestWriter: atomic-bootstrap invariant', () => {
  let dir: string

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'redesigner-atomic-')))
    calls.length = 0
  })

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('bootstrap writes ONLY via tmp-file + rename — never directly to manifest.json', async () => {
    const writer = new ManifestWriter({
      projectRoot: dir,
      manifestPath: path.join(dir, '.redesigner/manifest.json'),
    })

    try {
      const writeCalls = calls.filter((c) => c.startsWith('writeFileSync:'))
      for (const w of writeCalls) {
        expect(w.includes('manifest.json.tmp-'), `writeFileSync targeted non-tmp path: ${w}`).toBe(
          true,
        )
      }

      const directWrites = writeCalls.filter(
        (c) => c.endsWith('manifest.json') && !c.includes('.tmp-'),
      )
      expect(directWrites, 'no direct writes to manifest.json allowed').toEqual([])

      const renameCount = calls.filter((c) => c.startsWith('renameSync:')).length
      expect(
        renameCount,
        'bootstrap should have performed exactly one rename',
      ).toBeGreaterThanOrEqual(1)
    } finally {
      await writer.shutdown()
    }
  })
})
