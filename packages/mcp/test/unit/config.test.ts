import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/config'

function touchManifest(dir: string) {
  mkdirSync(path.join(dir, '.redesigner'), { recursive: true })
  writeFileSync(path.join(dir, '.redesigner/manifest.json'), '{}')
}
function touchPackage(dir: string, name = 'test') {
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, private: true }))
}

describe('resolveConfig', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'redesigner-config-')))
  })
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('--project wins over cwd walk', () => {
    const a = path.join(root, 'a')
    const b = path.join(root, 'b')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    touchManifest(a)
    touchPackage(a)
    touchManifest(b)
    touchPackage(b)

    const resolved = resolveConfig({ project: a }, b, { HOME: root })
    expect(resolved.projectRoot).toBe(realpathSync(a))
  })

  it('--project on missing path throws actionable error', () => {
    expect(() => resolveConfig({ project: path.join(root, 'nope') }, root, { HOME: root })).toThrow(
      /does not exist|cannot be read/,
    )
  })

  it('--project on dir without .redesigner throws', () => {
    const p = path.join(root, 'no-manifest')
    mkdirSync(p)
    touchPackage(p)
    expect(() => resolveConfig({ project: p }, p, { HOME: root })).toThrow(/no \.redesigner/)
  })

  it('walk-up finds nearest .redesigner + package.json', () => {
    const proj = path.join(root, 'proj')
    const sub = path.join(proj, 'src/nested')
    mkdirSync(sub, { recursive: true })
    touchManifest(proj)
    touchPackage(proj)

    const resolved = resolveConfig({}, sub, { HOME: root })
    expect(resolved.projectRoot).toBe(realpathSync(proj))
  })

  it('walk-up IGNORES a .redesigner without sibling package.json (planted-manifest attack)', () => {
    const attacker = path.join(root, 'attacker')
    const real = path.join(root, 'attacker', 'real')
    mkdirSync(real, { recursive: true })
    touchManifest(attacker)
    touchManifest(real)
    touchPackage(real)

    const resolved = resolveConfig({}, real, { HOME: root })
    expect(resolved.projectRoot).toBe(realpathSync(real))
  })

  it('walk-up stops at HOME ceiling', () => {
    expect(() => resolveConfig({}, root, { HOME: root })).toThrow(/no \.redesigner/)
  })

  it('walk-up stops at an enclosing non-matching package.json (monorepo boundary)', () => {
    const parent = path.join(root, 'parent')
    const child = path.join(parent, 'child')
    mkdirSync(child, { recursive: true })
    touchPackage(parent)
    // no .redesigner anywhere

    expect(() => resolveConfig({}, child, { HOME: root })).toThrow(/no \.redesigner/)
  })

  it('deleted cwd throws actionable error', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'redesigner-ghost-'))
    rmSync(tmp, { recursive: true, force: true })
    expect(() => resolveConfig({}, tmp, { HOME: root })).toThrow(/does not exist|cannot be read/)
  })
})
