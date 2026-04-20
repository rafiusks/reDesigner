import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const createdDirs = new Set<string>()

export function randomTempDir(prefix = 'redesigner-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  createdDirs.add(dir)
  return dir
}

export function cleanupTempDirs(): void {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
  createdDirs.clear()
}
