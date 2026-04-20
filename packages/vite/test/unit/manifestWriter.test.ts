import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PerFileBatch } from '../../src/core/types-internal'
import { ManifestWriter } from '../../src/integration/manifestWriter'

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'redesigner-test-'))
}

function batch(filePath: string, names: string[]): PerFileBatch {
  return {
    filePath,
    components: Object.fromEntries(
      names.map((n) => [
        `${filePath}::${n}`,
        {
          filePath,
          exportKind: 'named' as const,
          lineRange: [1, 1] as [number, number],
          displayName: n,
        },
      ]),
    ),
    locs: Object.fromEntries(
      names.map((n, i) => [
        `${filePath}:${i + 1}:1`,
        { componentKey: `${filePath}::${n}`, filePath, componentName: n },
      ]),
    ),
  }
}

describe('ManifestWriter', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('startup: mkdirs + writes empty manifest + sweeps tmp files', async () => {
    const dir = freshDir()
    const manifestPath = path.join(dir, '.redesigner', 'manifest.json')
    const w = new ManifestWriter({ projectRoot: dir, manifestPath })
    await w.quiesce()
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(m.schemaVersion).toBe('1.0')
    expect(m.components).toEqual({})
    expect(m.locs).toEqual({})
    expect(typeof m.contentHash).toBe('string')
    await w.shutdown()
  })

  it('commitFile + quiesce produces manifest with entries', async () => {
    const dir = freshDir()
    const w = new ManifestWriter({
      projectRoot: dir,
      manifestPath: path.join(dir, 'manifest.json'),
    })
    w.commitFile('src/a.tsx', batch('src/a.tsx', ['A']))
    await w.quiesce()
    const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    expect(Object.keys(m.components)).toContain('src/a.tsx::A')
    await w.shutdown()
  })

  it('per-file replace CAS: newer batch for same file overwrites previous', async () => {
    const dir = freshDir()
    const w = new ManifestWriter({
      projectRoot: dir,
      manifestPath: path.join(dir, 'manifest.json'),
    })
    w.commitFile('src/a.tsx', batch('src/a.tsx', ['A', 'A2']))
    w.commitFile('src/a.tsx', batch('src/a.tsx', ['B']))
    await w.quiesce()
    const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    expect(Object.keys(m.components)).toEqual(['src/a.tsx::B'])
    await w.shutdown()
  })

  it('debounce + maxWait: commits in rapid succession trigger at most one flush, bounded by maxWait', async () => {
    const dir = freshDir()
    const w = new ManifestWriter({
      projectRoot: dir,
      manifestPath: path.join(dir, 'manifest.json'),
    })
    // biome-ignore lint/suspicious/noExplicitAny: spying on private method
    const spy = vi.spyOn(w as any, 'flush')
    w.commitFile('src/a.tsx', batch('src/a.tsx', ['A']))
    await vi.advanceTimersByTimeAsync(100)
    w.commitFile('src/a.tsx', batch('src/a.tsx', ['B']))
    await vi.advanceTimersByTimeAsync(100)
    w.commitFile('src/a.tsx', batch('src/a.tsx', ['C']))
    await vi.advanceTimersByTimeAsync(1100) // past maxWait
    expect(spy).toHaveBeenCalledTimes(1)
    await w.shutdown()
  })

  it('collision: two writers for same manifestPath → second constructor throws', () => {
    const dir = freshDir()
    const p = path.join(dir, 'manifest.json')
    const w1 = new ManifestWriter({ projectRoot: dir, manifestPath: p })
    expect(() => new ManifestWriter({ projectRoot: dir, manifestPath: p })).toThrow(
      /two dev servers/,
    )
    w1.shutdown()
  })
})
