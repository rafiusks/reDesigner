import {
  JsonRpcNotificationSchema,
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
  WsFrameSchema,
} from '@redesigner/core/schemas'
import { expect, test } from 'vitest'

const v4 = () => crypto.randomUUID() // Node ≥22 provides v4 UUIDs

test('request with numeric id rejected', () => {
  expect(() => JsonRpcRequestSchema.parse({ jsonrpc: '2.0', id: 123, method: 'hello' })).toThrow()
})

test('request with null id rejected', () => {
  expect(() => JsonRpcRequestSchema.parse({ jsonrpc: '2.0', id: null, method: 'hello' })).toThrow()
})

test('request with UUIDv4 id accepted', () => {
  const frame = { jsonrpc: '2.0' as const, id: v4(), method: 'rpc.request' as const }
  expect(() => JsonRpcRequestSchema.parse(frame)).not.toThrow()
})

test('notification with id rejected (strict)', () => {
  expect(() =>
    JsonRpcNotificationSchema.parse({
      jsonrpc: '2.0',
      id: v4(),
      method: 'hello',
    }),
  ).toThrow()
})

test('response with both result and error rejected', () => {
  expect(() =>
    JsonRpcResponseSchema.parse({
      jsonrpc: '2.0',
      id: v4(),
      result: { ok: true },
      error: { code: -32000, message: 'boom' },
    }),
  ).toThrow()
})

test('response with neither result nor error rejected', () => {
  expect(() => JsonRpcResponseSchema.parse({ jsonrpc: '2.0', id: v4() })).toThrow()
})

test('response with id:null + error accepted (batch-rejection case)', () => {
  const frame = {
    jsonrpc: '2.0' as const,
    id: null,
    error: { code: -32600, message: 'Invalid Request — batch not supported in v0' },
  }
  expect(() => JsonRpcResponseSchema.parse(frame)).not.toThrow()
})

test('unknown method rejected by RedesignerMethod enum', () => {
  expect(() =>
    JsonRpcRequestSchema.parse({ jsonrpc: '2.0', id: v4(), method: 'unknown.method' }),
  ).toThrow()
})

test('unknown top-level key rejected by strict', () => {
  expect(() =>
    JsonRpcNotificationSchema.parse({
      jsonrpc: '2.0',
      method: 'hello',
      extras: 1,
    }),
  ).toThrow()
})

test('WsFrameSchema union resolves each variant', () => {
  const req = { jsonrpc: '2.0' as const, id: v4(), method: 'rpc.request' as const }
  const note = { jsonrpc: '2.0' as const, method: 'hello' as const }
  const res = { jsonrpc: '2.0' as const, id: v4(), result: { ok: true } }
  expect(() => WsFrameSchema.parse(req)).not.toThrow()
  expect(() => WsFrameSchema.parse(note)).not.toThrow()
  expect(() => WsFrameSchema.parse(res)).not.toThrow()
})
