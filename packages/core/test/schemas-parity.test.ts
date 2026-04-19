import {
  ExchangeRequestSchema,
  ExchangeResponseSchema,
  HandshakeSchema,
  SelectionPutBodySchema,
  SelectionPutResponseSchema,
} from '@redesigner/core/schemas'
import { expect, test } from 'vitest'
import { z } from 'zod'

function toJSONSchemaFor(schema: z.ZodTypeAny): unknown {
  const js = (z as unknown as { toJSONSchema: (s: z.ZodTypeAny) => unknown }).toJSONSchema(
    schema,
  ) as Record<string, unknown>
  const { $schema, ...rest } = js
  return rest
}

test.each([
  ['HandshakeSchema', HandshakeSchema],
  ['ExchangeRequestSchema', ExchangeRequestSchema],
  ['ExchangeResponseSchema', ExchangeResponseSchema],
  ['SelectionPutBodySchema', SelectionPutBodySchema],
  ['SelectionPutResponseSchema', SelectionPutResponseSchema],
])('%s JSON Schema matches committed golden', (name, schema) => {
  expect(toJSONSchemaFor(schema as z.ZodTypeAny)).toMatchSnapshot()
})

test('Handshake sample round-trips', () => {
  const sample = {
    wsUrl: 'ws://localhost:5173/__redesigner/ws',
    httpUrl: 'http://localhost:5173/__redesigner',
    bootstrapToken: 'abcdef012345',
    editor: 'vscode' as const,
    pluginVersion: '0.0.0',
    daemonVersion: '0.0.0',
  }
  expect(HandshakeSchema.parse(sample)).toEqual(sample)
})

test('SelectionPutBody enforces nodes.min(1).max(1)', () => {
  const node = {
    id: 'a',
    componentName: 'Button',
    filePath: 'src/Button.tsx',
    lineRange: [1, 10] as [number, number],
    domPath: 'html>body>button',
    parentChain: ['body', 'html'],
    timestamp: 0,
  }
  const valid = { nodes: [node], clientId: '0f0b1f12-34cd-4ef6-a789-0b1c2d3e4f50' }
  expect(SelectionPutBodySchema.parse(valid).nodes.length).toBe(1)
  expect(() => SelectionPutBodySchema.parse({ ...valid, nodes: [] })).toThrow()
  expect(() => SelectionPutBodySchema.parse({ ...valid, nodes: [node, node] })).toThrow()
  expect(() => SelectionPutBodySchema.parse({ ...valid, clientId: 'not-a-uuid' })).toThrow()
})
