/**
 * E-12: parallelism — 50 concurrent transform requests against distinct files,
 * verifying the ManifestWriter CAS path (debounce + atomic rename) preserves
 * every commit with no lost writes under races.
 *
 * Runs under the dedicated vitest config (test/vitest.parallelism.config.ts):
 *   pool: 'forks' + isolate + fileParallelism:false.
 *
 * Isolation: each test uses a fresh fs.mkdtempSync root. 50 concurrent writers
 * against a shared .redesigner/ directory would trip the .owner-lock collision
 * throw in ManifestWriter; per-test tmpdir is non-negotiable here.
 *
 * The default vitest suite excludes this file (see vitest.config.ts) so only
 * `pnpm run test:parallelism` runs it.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ESBuildOptions, type ViteDevServer, createServer } from 'vite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import redesigner from '../../src/index'
import { readManifest } from '../../src/reader'

// Resolve to packages/vite for React aliases; the tmpdir project has no react
// installed, so Vite's resolver is pointed at our own node_modules.
const PKG_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..')
const REACT_DIR = path.join(PKG_ROOT, 'node_modules/react')

const N_FILES = 50

describe('vite integration: 50 parallel transforms CAS stress', () => {
  let dir: string
  let server: ViteDevServer | undefined

  beforeEach(async () => {
    // realpathSync required on macOS (/var/folders → /private/var/folders symlink)
    // to keep mkdtempSync paths and Vite-resolved ids in agreement.
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'redesigner-parallel-')))
    mkdirSync(path.join(dir, 'src'), { recursive: true })

    // Generate N_FILES distinct single-component TSX files. Each component
    // renders <div><span>…</span></div> → two host elements (= 2 loc entries)
    // plus one ComponentRecord.
    for (let i = 0; i < N_FILES; i++) {
      const name = `C${String(i).padStart(2, '0')}`
      writeFileSync(
        path.join(dir, `src/${name}.tsx`),
        `export default function ${name}() { return <div><span>c${i}</span></div> }\n`,
      )
    }

    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'parallel-test', type: 'module', version: '0.0.0', private: true }),
    )

    server = await createServer({
      root: dir,
      configFile: false,
      // daemon: 'off' — this test is about writer CAS, not daemon handoff.
      plugins: [redesigner({ daemon: 'off' })],
      esbuild: { jsx: 'automatic' } as ESBuildOptions,
      server: { port: 0, strictPort: false, middlewareMode: true, fs: { strict: false } },
      resolve: {
        alias: {
          'react/jsx-dev-runtime': path.join(REACT_DIR, 'jsx-dev-runtime.js'),
          'react/jsx-runtime': path.join(REACT_DIR, 'jsx-runtime.js'),
          react: path.join(REACT_DIR, 'index.js'),
        },
      },
      clearScreen: false,
    })
  }, 15000)

  afterEach(async () => {
    // Race server.close() against a 2s ceiling — same rationale as reinit.test.ts:
    // macOS watcher teardown occasionally hangs in headless vitest.
    await Promise.race([
      server?.close() ?? Promise.resolve(),
      new Promise<void>((r) => setTimeout(r, 2000)),
    ])
    server = undefined
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 10000)

  it('transforms 50 files concurrently; manifest contains all 50 entries', async () => {
    const urls = Array.from(
      { length: N_FILES },
      (_, i) => `/src/C${String(i).padStart(2, '0')}.tsx`,
    )

    // Fire all 50 transformRequests in parallel. Each commit races the writer's
    // debounce window + atomic rename. Soft-benchmark the wall time.
    const startedAt = Date.now()
    if (!server) throw new Error('server not initialized')
    const s = server
    const results = await Promise.all(urls.map((u) => s.transformRequest(u)))
    const elapsedMs = Date.now() - startedAt

    // Every result must be non-null and contain data-redesigner-loc in the
    // compiled output (jsxDEV prop form).
    for (const r of results) {
      expect(r).not.toBeNull()
      if (r) expect(r.code).toContain('data-redesigner-loc')
    }

    // Poll the manifest until all 50 components appear or deadline hits.
    // Debounce window is ~200ms; 15s deadline gives huge slack for CI.
    const manifestPath = path.join(dir, '.redesigner/manifest.json')
    const deadline = Date.now() + 15000
    let manifest = await readManifest(manifestPath)
    while (Date.now() < deadline) {
      manifest = await readManifest(manifestPath)
      const componentCount = Object.keys(manifest.components).length
      if (componentCount >= N_FILES) break
      await new Promise((r) => setTimeout(r, 100))
    }

    // Invariant: 50 components present.
    const componentKeys = Object.keys(manifest.components)
    expect(
      componentKeys.length,
      `expected ≥${N_FILES} components; got ${componentKeys.length}. Wall time for 50 parallel transforms: ${elapsedMs}ms`,
    ).toBeGreaterThanOrEqual(N_FILES)

    // Every expected component is present with correct shape.
    for (let i = 0; i < N_FILES; i++) {
      const name = `C${String(i).padStart(2, '0')}`
      const expectedKey = `src/${name}.tsx::${name}`
      const rec = manifest.components[expectedKey]
      expect(rec, `missing component ${expectedKey}`).toBeDefined()
      if (!rec) continue
      expect(rec.filePath).toBe(`src/${name}.tsx`)
      expect(rec.exportKind).toBe('default')
      expect(rec.displayName).toBe(name)
    }

    // Every file contributes ≥2 loc entries (<div> + <span>).
    // Sum across files must be ≥ 2 * N_FILES.
    const locKeys = Object.keys(manifest.locs)
    expect(
      locKeys.length,
      `expected ≥${2 * N_FILES} locs total (2 per file); got ${locKeys.length}`,
    ).toBeGreaterThanOrEqual(2 * N_FILES)

    for (let i = 0; i < N_FILES; i++) {
      const name = `C${String(i).padStart(2, '0')}`
      const locsForFile = locKeys.filter((k) => k.startsWith(`src/${name}.tsx:`))
      expect(
        locsForFile.length,
        `file src/${name}.tsx expected ≥2 loc entries; got ${locsForFile.length}`,
      ).toBeGreaterThanOrEqual(2)
    }

    // contentHash must be a non-empty sha256 hex (64 chars) — asserts the flush
    // actually finalized the manifest rather than leaving a stale header.
    expect(manifest.contentHash).toMatch(/^[0-9a-f]{64}$/)

    // Print the soft benchmark so it shows up in vitest output.
    // Not an assertion — just visibility for the caller.
    console.log(`[parallelism] 50 parallel transforms completed in ${elapsedMs}ms`)
  }, 30000)
})
