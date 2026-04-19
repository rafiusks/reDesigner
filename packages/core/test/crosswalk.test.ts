import {
  type ApiErrorCode,
  ApiErrorCodeToHttpStatus,
  ApiErrorCodeToRpc,
  RpcErrorCode,
  RpcToApiErrorCode,
} from '@redesigner/core/schemas'
import { expect, test } from 'vitest'

const API_CODES = [
  'extension-disconnected',
  'extension-timeout',
  'extension-no-active-pick',
  'element-not-found',
  'result-too-large',
  'shutdown',
  'instance-changed',
  'rate-limit-exceeded',
  'version-not-acceptable',
  'invalid-params',
  'internal-error',
  'host-rejected',
  'method-not-allowed',
  'not-found',
  'unknown-extension',
  'stale-selection',
  'endpoint-moved',
  'session-revalidate-exhausted',
] as const satisfies readonly ApiErrorCode[]

test('crosswalks are total over ApiErrorCode', () => {
  for (const c of API_CODES) {
    expect(ApiErrorCodeToHttpStatus[c]).toBeTypeOf('number')
    expect(Object.hasOwn(ApiErrorCodeToRpc, c)).toBe(true)
  }
  // Defensive: no extra keys in either map beyond API_CODES.
  expect(Object.keys(ApiErrorCodeToHttpStatus).sort()).toEqual([...API_CODES].sort())
  expect(Object.keys(ApiErrorCodeToRpc).sort()).toEqual([...API_CODES].sort())
})

test('RpcErrorCode values are in JSON-RPC server-error range -32000..-32099 or standard codes', () => {
  for (const v of Object.values(RpcErrorCode)) {
    // Numeric enums reverse-map: Object.values returns both numbers and their string aliases. Filter to numbers.
    if (typeof v === 'number') {
      const inServerRange = v >= -32099 && v <= -32000
      const isStandard =
        v === -32600 || v === -32601 || v === -32602 || v === -32603 || v === -32700
      expect(inServerRange || isStandard).toBe(true)
    }
  }
})

test('ApiErrorCodeToRpc null entries are REST-only (have HTTP status)', () => {
  for (const [api, rpc] of Object.entries(ApiErrorCodeToRpc)) {
    if (rpc === null) {
      expect(ApiErrorCodeToHttpStatus[api as ApiErrorCode]).toBeTypeOf('number')
    }
  }
})

test('RpcToApiErrorCode inverts ApiErrorCodeToRpc for non-null entries', () => {
  for (const [api, rpc] of Object.entries(ApiErrorCodeToRpc)) {
    if (rpc !== null) {
      expect(RpcToApiErrorCode[rpc as RpcErrorCode]).toBe(api)
    }
  }
})
