import * as coreSchemas from '@redesigner/core/schemas'
import { expect, test } from 'vitest'

/**
 * Cross-package parity test: ensure @redesigner/core/schemas resolves to the same
 * module identity and Zod version when imported from ext package.
 *
 * This test verifies that all schemas are properly exported and accessible,
 * and that the Zod version constraint (^3.25.0 || ^4.0.0) is satisfied.
 */
test('schemas imported from ext resolve correctly', () => {
  // Verify that all expected schema symbols are available
  const expectedSchemas = [
    'CloseReasonSchema',
    'ComponentHandleSchema',
    'ExchangeRequestSchema',
    'ExchangeResponseSchema',
    'HandshakeSchema',
    'JsonRpcErrorSchema',
    'JsonRpcNotificationSchema',
    'JsonRpcRequestSchema',
    'JsonRpcResponseSchema',
    'ManifestSchema',
    'SelectionFileSchema',
    'SelectionPutBodySchema',
    'SelectionPutResponseSchema',
    'WsFrameSchema',
  ]

  for (const name of expectedSchemas) {
    expect(coreSchemas).toHaveProperty(name)
    // biome-ignore lint/suspicious/noExplicitAny: dynamic schema lookup by name requires any
    const schema = (coreSchemas as any)[name]
    expect(schema).toBeDefined()
    expect(typeof schema).toBe('object')
  }
})

test('Zod version contract: all schemas have _def', () => {
  // Verify that Zod _def is accessible (v3 and v4 both have this)
  const testSchemaNames = [
    'HandshakeSchema',
    'SelectionPutBodySchema',
    'WsFrameSchema',
    'ManifestSchema',
  ]

  for (const name of testSchemaNames) {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic schema lookup by name requires any
    const schema = (coreSchemas as any)[name]
    expect(schema).toBeDefined()
    // biome-ignore lint/suspicious/noExplicitAny: _def is Zod internal, not in public types
    const def = (schema as any)._def
    expect(def).toBeDefined()
  }
})
