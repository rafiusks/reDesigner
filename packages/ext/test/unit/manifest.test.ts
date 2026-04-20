/**
 * Task 15 — manifest scaffold invariants.
 *
 * Asserts the on-disk manifest.json shape required by the plan:
 *  - MV3, minimum_chrome_version, key (dev-stable ID), arm-picker chord, host permissions set,
 *    content_scripts document_start bootstrap + document_end main, referenced files exist.
 *
 * Deliberately NOT testing CRXJS build output — scaffolding only.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const pkgRoot = resolve(import.meta.dirname, '..', '..')
const manifestPath = resolve(pkgRoot, 'manifest.json')

interface ContentScript {
  matches: string[]
  run_at?: 'document_start' | 'document_end' | 'document_idle'
  js?: string[]
}

interface Manifest {
  manifest_version: number
  name: string
  version: string
  minimum_chrome_version?: string
  key?: string
  commands?: Record<
    string,
    { suggested_key?: { default?: string; mac?: string }; description?: string }
  >
  host_permissions?: string[]
  content_scripts?: ContentScript[]
}

const loadManifest = (): Manifest => {
  const raw = readFileSync(manifestPath, 'utf8')
  return JSON.parse(raw) as Manifest
}

describe('packages/ext manifest.json scaffold', () => {
  it('is Manifest V3', () => {
    const m = loadManifest()
    expect(m.manifest_version).toBe(3)
  })

  it('pins minimum_chrome_version to "120"', () => {
    const m = loadManifest()
    expect(m.minimum_chrome_version).toBe('120')
  })

  it('carries a non-empty key field (dev-stable extension ID)', () => {
    const m = loadManifest()
    expect(typeof m.key).toBe('string')
    expect((m.key ?? '').length).toBeGreaterThan(0)
  })

  it('binds arm-picker to Alt+Shift+D on default and mac', () => {
    const m = loadManifest()
    const armPicker = m.commands?.['arm-picker']
    expect(armPicker).toBeDefined()
    expect(armPicker?.suggested_key?.default).toBe('Alt+Shift+D')
    expect(armPicker?.suggested_key?.mac).toBe('Alt+Shift+D')
  })

  it('has exactly the four localhost host_permissions (order-independent)', () => {
    const m = loadManifest()
    const expected = new Set([
      'http://localhost/*',
      'http://127.0.0.1/*',
      'http://*.localhost/*',
      'http://[::1]/*',
    ])
    const actual = new Set(m.host_permissions ?? [])
    expect(actual).toEqual(expected)
  })

  it('declares two content_scripts: document_start bootstrap + document_end main', () => {
    const m = loadManifest()
    const cs = m.content_scripts ?? []
    expect(cs.length).toBe(2)

    const byRunAt = new Map(cs.map((entry) => [entry.run_at, entry]))
    expect(byRunAt.has('document_start')).toBe(true)
    expect(byRunAt.has('document_end')).toBe(true)
  })

  it('points content_scripts at bootstrap + main files that exist on disk', () => {
    const m = loadManifest()
    const cs = m.content_scripts ?? []

    // Entry order in the manifest: [0] = document_start bootstrap, [1] = document_end main
    const bootstrap = cs[0]
    const main = cs[1]
    expect(bootstrap?.run_at).toBe('document_start')
    expect(main?.run_at).toBe('document_end')

    const bootstrapJs = bootstrap?.js?.[0]
    const mainJs = main?.js?.[0]
    expect(typeof bootstrapJs).toBe('string')
    expect(typeof mainJs).toBe('string')
    expect(bootstrapJs).toMatch(/bootstrap/i)
    expect(mainJs).toMatch(/index|main|content/i)

    // Files must exist on disk so CRXJS can resolve them.
    expect(existsSync(resolve(pkgRoot, bootstrapJs as string))).toBe(true)
    expect(existsSync(resolve(pkgRoot, mainJs as string))).toBe(true)
  })
})
