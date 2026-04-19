import { readFile } from 'node:fs/promises'
import { safeJsonParse } from './safeJsonParse'
import type { Manifest } from './types'

export const SUPPORTED_MAJOR = 1

export interface ReadManifestOptions {
  expectedMajor?: number
  maxRetries?: number
  retryDelayMs?: number
}

function parseMajor(schemaVersion: string): number {
  const majorStr = schemaVersion.split('.')[0]
  if (!majorStr) throw new Error(`[redesigner] malformed schemaVersion: ${schemaVersion}`)
  const major = Number(majorStr)
  if (!Number.isFinite(major))
    throw new Error(`[redesigner] non-numeric schemaVersion major: ${schemaVersion}`)
  return major
}

export async function readManifest(
  manifestPath: string,
  opts: ReadManifestOptions = {},
): Promise<Manifest> {
  const expectedMajor = opts.expectedMajor ?? SUPPORTED_MAJOR
  const maxRetries = opts.maxRetries ?? 1
  const retryDelayMs = opts.retryDelayMs ?? 50

  let lastErr: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const raw = await readFile(manifestPath, 'utf8')
      const parsed = safeJsonParse(raw) as Manifest
      const major = parseMajor(parsed.schemaVersion)
      if (major !== expectedMajor) {
        throw new Error(
          `[redesigner] schema major mismatch: manifest=${major}, expected=${expectedMajor}`,
        )
      }
      return parsed
    } catch (err) {
      lastErr = err
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, retryDelayMs))
    }
  }
  throw lastErr
}
