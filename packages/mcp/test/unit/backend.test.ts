import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it, vi } from 'vitest'
import { FileBackend } from '../../src/backend'

// Re-export node:fs/promises through a mutable namespace so vi.spyOn can
// redefine exports (native ESM namespaces are frozen, which breaks spyOn).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual }
})

const MINIMAL_MANIFEST = `{"schemaVersion":"1.0","framework":"react","generatedAt":"","contentHash":"${'a'.repeat(64)}","components":{},"locs":{}}`

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/minimal-project',
)

describe('FileBackend', () => {
  it('getManifest returns parsed manifest from the fixture', async () => {
    const backend = new FileBackend({
      projectRoot: FIXTURE,
      manifestPath: path.join(FIXTURE, '.redesigner/manifest.json'),
      selectionPath: path.join(FIXTURE, '.redesigner/selection.json'),
    })
    const m = await backend.getManifest()
    expect(Object.keys(m.components)).toHaveLength(2)
    expect(Object.keys(m.locs)).toHaveLength(3)
  })

  it('getCurrentSelection returns null when selection.json is missing', async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'redesigner-backend-')))
    try {
      writeFileSync(path.join(dir, 'manifest.json'), MINIMAL_MANIFEST)
      const backend = new FileBackend({
        projectRoot: dir,
        manifestPath: path.join(dir, 'manifest.json'),
        selectionPath: path.join(dir, 'selection.json'),
      })
      expect(await backend.getCurrentSelection()).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('getCurrentSelection returns parsed handle from fixture', async () => {
    const backend = new FileBackend({
      projectRoot: FIXTURE,
      manifestPath: path.join(FIXTURE, '.redesigner/manifest.json'),
      selectionPath: path.join(FIXTURE, '.redesigner/selection.json'),
    })
    const sel = await backend.getCurrentSelection()
    expect(sel?.id).toBe('sel-001')
    expect(sel?.componentName).toBe('Foo')
  })

  it('getRecentSelections returns history slice', async () => {
    const backend = new FileBackend({
      projectRoot: FIXTURE,
      manifestPath: path.join(FIXTURE, '.redesigner/manifest.json'),
      selectionPath: path.join(FIXTURE, '.redesigner/selection.json'),
    })
    expect(await backend.getRecentSelections(1)).toHaveLength(1)
    expect(await backend.getRecentSelections(5)).toHaveLength(1)
  })

  it('getComputedStyles returns null in FileBackend', async () => {
    const backend = new FileBackend({
      projectRoot: FIXTURE,
      manifestPath: path.join(FIXTURE, '.redesigner/manifest.json'),
      selectionPath: path.join(FIXTURE, '.redesigner/selection.json'),
    })
    expect(await backend.getComputedStyles('sel-001')).toBeNull()
  })

  it('getDomSubtree returns null in FileBackend', async () => {
    const backend = new FileBackend({
      projectRoot: FIXTURE,
      manifestPath: path.join(FIXTURE, '.redesigner/manifest.json'),
      selectionPath: path.join(FIXTURE, '.redesigner/selection.json'),
    })
    expect(await backend.getDomSubtree('sel-001', 2)).toBeNull()
  })

  it('malformed JSON → McpError InvalidRequest', async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'redesigner-backend-')))
    try {
      writeFileSync(path.join(dir, 'selection.json'), '{not json')
      writeFileSync(path.join(dir, 'manifest.json'), MINIMAL_MANIFEST)
      const backend = new FileBackend({
        projectRoot: dir,
        manifestPath: path.join(dir, 'manifest.json'),
        selectionPath: path.join(dir, 'selection.json'),
      })
      await expect(backend.getCurrentSelection()).rejects.toMatchObject({
        code: ErrorCode.InvalidRequest,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('schema mismatch → McpError InvalidRequest with path', async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'redesigner-backend-')))
    try {
      writeFileSync(path.join(dir, 'selection.json'), '{"current": null}')
      writeFileSync(path.join(dir, 'manifest.json'), MINIMAL_MANIFEST)
      const backend = new FileBackend({
        projectRoot: dir,
        manifestPath: path.join(dir, 'manifest.json'),
        selectionPath: path.join(dir, 'selection.json'),
      })
      await expect(backend.getCurrentSelection()).rejects.toMatchObject({
        code: ErrorCode.InvalidRequest,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('oversized selection → FileTooLargeError', async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'redesigner-backend-')))
    try {
      const big = JSON.stringify({ current: null, history: [], pad: 'x'.repeat(2 * 1024 * 1024) })
      writeFileSync(path.join(dir, 'selection.json'), big)
      writeFileSync(path.join(dir, 'manifest.json'), MINIMAL_MANIFEST)
      const backend = new FileBackend({
        projectRoot: dir,
        manifestPath: path.join(dir, 'manifest.json'),
        selectionPath: path.join(dir, 'selection.json'),
      })
      await expect(backend.getCurrentSelection()).rejects.toThrow(/size limit/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('caches within TTL — two rapid calls issue one read', async () => {
    const backend = new FileBackend({
      projectRoot: FIXTURE,
      manifestPath: path.join(FIXTURE, '.redesigner/manifest.json'),
      selectionPath: path.join(FIXTURE, '.redesigner/selection.json'),
    })
    const fs = await import('node:fs/promises')
    const spy = vi.spyOn(fs, 'readFile')

    await backend.getCurrentSelection()
    await backend.getCurrentSelection()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
