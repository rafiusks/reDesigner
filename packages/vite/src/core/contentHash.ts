import { createHash } from 'node:crypto'
import type { Manifest } from './types-public'

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`
  }
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(',')}}`
}

export function computeContentHash(manifest: Manifest): string {
  const { components, locs } = manifest
  const canonical = canonicalize({ components, locs })
  const bytes = new TextEncoder().encode(canonical)
  return createHash('sha256').update(bytes).digest('hex')
}
