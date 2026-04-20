import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as coreSchemas from '@redesigner/core/schemas'
import { expect, test } from 'vitest'
import { z } from 'zod'

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

/**
 * Cross-package Zod module identity contract.
 *
 * Why: if ext and core each resolve a different copy of zod (major or minor),
 * schemas validated in ext would silently accept/reject differently than in
 * core — and instanceof checks across the boundary return false. pnpm's
 * workspace resolution should pin all packages to the same zod snapshot, but
 * nothing structurally prevents drift. This test fails loudly if drift occurs.
 *
 * Signals used to distinguish v3 vs v4 (pinned via .zod-version at repo root):
 *  - v3: schema._def.typeName is a string (e.g. 'ZodString'), toJSONSchema is absent
 *  - v4: schema._def only has a 'type' key, z.toJSONSchema is a function
 */
test('Zod module identity: ext and core share a single Zod copy', () => {
  // Core schema must be an instance of ext's locally-imported Zod class.
  // If core resolved a different Zod copy, the class identity would differ
  // and instanceof would return false.
  expect(coreSchemas.HandshakeSchema).toBeInstanceOf(z.ZodObject)
  expect(coreSchemas.HandshakeSchema).toBeInstanceOf(z.ZodType)

  // Class name sanity (confirms we got the real class, not a Proxy/wrapper).
  expect(z.ZodObject.name).toBe('ZodObject')
  expect(z.ZodString.name).toBe('ZodString')
})

test('Zod major version matches .zod-version pinning', () => {
  // Read the pinned major from repo root. Path is relative to this test file:
  // packages/ext/test/contract/goldens.test.ts -> ../../../../.zod-version
  const versionPath = fileURLToPath(new URL('../../../../.zod-version', import.meta.url))
  const expectedMajor = readFileSync(versionPath, 'utf8').trim()
  expect(expectedMajor).toMatch(/^[0-9]+$/)

  // Detect the Zod major from structural signals on a locally-constructed schema.
  // v4 exposes z.toJSONSchema (added in v4.0); v3 does not.
  // v3 sets schema._def.typeName (e.g. 'ZodString'); v4 replaces that with _def.type.
  // biome-ignore lint/suspicious/noExplicitAny: _def is Zod internal, not in public types
  const sampleDef = (z.string() as any)._def
  const hasToJSONSchema =
    typeof (z as unknown as { toJSONSchema?: unknown }).toJSONSchema === 'function'
  const hasTypeName = typeof sampleDef.typeName === 'string'

  let detectedMajor: string
  if (hasToJSONSchema && !hasTypeName) {
    detectedMajor = '4'
  } else if (!hasToJSONSchema && hasTypeName) {
    detectedMajor = '3'
  } else {
    throw new Error(
      `Unable to detect Zod major: hasToJSONSchema=${hasToJSONSchema} hasTypeName=${hasTypeName}`,
    )
  }

  expect(detectedMajor).toBe(expectedMajor)
})
