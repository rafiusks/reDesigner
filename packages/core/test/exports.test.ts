import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schemas from '@redesigner/core/schemas'
import { expect, test } from 'vitest'

test('schemas subpath exposes Zod runtime', () => {
  expect(typeof schemas.ComponentHandleSchema?.parse).toBe('function')
})

test('types subpath bundles no Zod runtime', async () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const typesDist = resolve(here, '../dist/types/index.js')
  const src = await readFile(typesDist, 'utf8')
  expect(src).not.toMatch(/from\s+['"]zod['"]/)
  expect(src).not.toMatch(/require\(['"]zod['"]\)/)
})
