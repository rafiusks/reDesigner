import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ManifestWatcher } from '../../src/state/manifestWatcher.js'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

function validManifest(): object {
  return {
    schemaVersion: '1.0',
    framework: 'react',
    generatedAt: new Date().toISOString(),
    contentHash: 'a'.repeat(64),
    components: {},
    locs: {},
  }
}

describe('ManifestWatcher smoke', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redwatch-'))
  })

  it('start() resolves without manifest (cached=null)', async () => {
    const m = new ManifestWatcher(
      path.join(dir, 'manifest.json'),
      () => {},
      fs.promises.readFile,
      fs.promises.stat,
      noopLogger,
    )
    await m.start()
    expect(m.getCached()).toBe(null)
    await m.stop()
  })

  it('start() validates existing manifest and overwrites contentHash with recomputed hash', async () => {
    const manifest = validManifest()
    const raw = JSON.stringify(manifest)
    fs.writeFileSync(path.join(dir, 'manifest.json'), raw)
    const expectedHash = crypto.createHash('sha256').update(raw).digest('hex')
    let received: { contentHash: string } | null = null
    const m = new ManifestWatcher(
      path.join(dir, 'manifest.json'),
      (mf) => {
        received = mf
      },
      fs.promises.readFile,
      fs.promises.stat,
      noopLogger,
    )
    await m.start()
    expect(m.getCached()).not.toBe(null)
    expect(m.getCached()?.contentHash).toBe(expectedHash)
    expect(received).not.toBe(null)
    expect(received?.contentHash).toBe(expectedHash)
    await m.stop()
  })
})
