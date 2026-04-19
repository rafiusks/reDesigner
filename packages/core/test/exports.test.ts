import * as schemas from '@redesigner/core/schemas'
import * as types from '@redesigner/core/types'
import { expect, test } from 'vitest'

test('schemas subpath exports Zod runtime', () => {
  expect(typeof schemas.ComponentHandleSchema?.parse).toBe('function')
})

test('types subpath exposes erased type-only re-exports at runtime (empty namespace OK)', () => {
  // TypeScript types are erased; the module must load and evaluate.
  expect(types).toBeDefined()
  // Any non-type runtime value re-exported will appear; at minimum the module loads.
})
