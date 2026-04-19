import { describe, expect, it } from 'vitest'
import { DaemonBackend } from '../../src/daemonBackend.js'

describe('DaemonBackend smoke', () => {
  it('inherits getManifest + getConfig from FileBackend', () => {
    const backend = new DaemonBackend({
      projectRoot: '/tmp',
      manifestPath: '/tmp/.redesigner/manifest.json',
      selectionPath: '/tmp/.redesigner/selection.json',
    })
    expect(typeof backend.getManifest).toBe('function')
    expect(typeof backend.getCurrentSelection).toBe('function')
  })
  it('returns null from getCurrentSelection when handoff absent', async () => {
    const backend = new DaemonBackend({
      projectRoot: '/tmp/this-project-does-not-exist-12345',
      manifestPath: '/tmp/nope/.redesigner/manifest.json',
      selectionPath: '/tmp/nope/.redesigner/selection.json',
    })
    const sel = await backend.getCurrentSelection()
    expect(sel).toBe(null)
  })
})
