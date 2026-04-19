import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Manifest } from '../../src/core/types-public'
import { SUPPORTED_MAJOR, computeContentHash, readManifest } from '../../src/reader'

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'redesigner-manifest-'))
}

function baseManifest(
  overrides: Partial<Record<keyof Manifest, unknown>> = {},
): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    framework: 'react',
    generatedAt: '2026-04-18T00:00:00.000Z',
    contentHash: '',
    components: {},
    locs: {},
    ...overrides,
  }
}

describe('manifest: reader + contentHash', () => {
  it('SUPPORTED_MAJOR is 1', () => {
    expect(SUPPORTED_MAJOR).toBe(1)
  })

  it('readManifest parses a valid v1.0 manifest', async () => {
    const dir = freshDir()
    const p = path.join(dir, 'manifest.json')
    const m = baseManifest({
      components: {
        'src/a.tsx::A': {
          filePath: 'src/a.tsx',
          exportKind: 'named',
          lineRange: [1, 1],
          displayName: 'A',
        },
      },
    }) as unknown as Manifest
    m.contentHash = computeContentHash(m)
    writeFileSync(p, JSON.stringify(m, null, 2))
    const out = await readManifest(p)
    expect(out.schemaVersion).toBe('1.0')
    expect(out.components['src/a.tsx::A']).toBeDefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it('readManifest rejects major mismatch', async () => {
    const dir = freshDir()
    const p = path.join(dir, 'manifest.json')
    writeFileSync(p, JSON.stringify(baseManifest({ schemaVersion: '2.0' }), null, 2))
    await expect(readManifest(p)).rejects.toThrow(/schema major mismatch/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('readManifest accepts minor-ahead (e.g., 1.5)', async () => {
    const dir = freshDir()
    const p = path.join(dir, 'manifest.json')
    writeFileSync(p, JSON.stringify(baseManifest({ schemaVersion: '1.5' }), null, 2))
    const out = await readManifest(p)
    expect(out.schemaVersion).toBe('1.5')
    rmSync(dir, { recursive: true, force: true })
  })

  it('readManifest retries once on parse failure', async () => {
    const dir = freshDir()
    const p = path.join(dir, 'manifest.json')
    // Write invalid JSON first
    writeFileSync(p, '{ not json')
    // Kick off read; before retry fires, write valid JSON
    const readPromise = readManifest(p, { retryDelayMs: 50, maxRetries: 1 })
    await new Promise((r) => setTimeout(r, 25))
    writeFileSync(p, JSON.stringify(baseManifest(), null, 2))
    const out = await readPromise
    expect(out.schemaVersion).toBe('1.0')
    rmSync(dir, { recursive: true, force: true })
  })

  it('contentHash: excludes generatedAt — same components produce same hash regardless of timestamp', () => {
    const m1 = baseManifest({ generatedAt: '2020-01-01T00:00:00.000Z' }) as unknown as Manifest
    const m2 = baseManifest({ generatedAt: '2099-12-31T23:59:59.999Z' }) as unknown as Manifest
    expect(computeContentHash(m1)).toBe(computeContentHash(m2))
  })

  it('contentHash: changes when components change', () => {
    const m1 = baseManifest() as unknown as Manifest
    const m2 = baseManifest({
      components: {
        'src/a.tsx::A': {
          filePath: 'src/a.tsx',
          exportKind: 'named',
          lineRange: [1, 1],
          displayName: 'A',
        },
      },
    }) as unknown as Manifest
    expect(computeContentHash(m1)).not.toBe(computeContentHash(m2))
  })
})
