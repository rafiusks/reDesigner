import { describe, expect, it } from 'vitest'
import {
  HelloFrameSchema,
  ManifestUpdatedFrameSchema,
  RpcRequestFrameSchema,
  RpcResponseFrameSchema,
  SelectionUpdatedFrameSchema,
} from '../../src/ws/frames.js'

describe('frame schemas', () => {
  it('hello requires snapshot', () => {
    expect(
      HelloFrameSchema.safeParse({
        type: 'hello',
        seq: 1,
        payload: {
          serverVersion: '0.0.1',
          instanceId: '00000000-0000-0000-0000-000000000000',
          snapshotSeq: 0,
          snapshot: { current: null, recent: [], manifestMeta: null },
        },
      }).success,
    ).toBe(true)
  })

  it('rpc.response requires jsonrpc 2.0', () => {
    const bad = RpcResponseFrameSchema.safeParse({
      type: 'rpc.response',
      payload: { id: 'x', result: {} },
    })
    expect(bad.success).toBe(false)

    const good = RpcResponseFrameSchema.safeParse({
      type: 'rpc.response',
      payload: { jsonrpc: '2.0', id: 'x', result: {} },
    })
    expect(good.success).toBe(true)
  })

  it('selection.updated accepts valid handle', () => {
    expect(
      SelectionUpdatedFrameSchema.safeParse({
        type: 'selection.updated',
        seq: 2,
        payload: {
          current: {
            id: 'btn-001',
            componentName: 'Btn',
            filePath: '/src/Btn.tsx',
            lineRange: [1, 10],
            domPath: 'div > button',
            parentChain: [],
            timestamp: 0,
          },
          staleManifest: false,
          tabId: 42,
          selectionSeq: 1,
        },
      }).success,
    ).toBe(true)
  })

  it('manifest.updated accepts contentHash and count', () => {
    expect(
      ManifestUpdatedFrameSchema.safeParse({
        type: 'manifest.updated',
        seq: 3,
        payload: { contentHash: 'abc123', componentCount: 42 },
      }).success,
    ).toBe(true)
  })

  it('rpc.request rejects unknown method', () => {
    const bad = RpcRequestFrameSchema.safeParse({
      type: 'rpc.request',
      seq: 4,
      payload: {
        jsonrpc: '2.0',
        id: 'a'.repeat(32),
        method: 'unknownMethod',
        params: {
          handle: {
            id: 'x-001',
            componentName: 'X',
            filePath: '/x.tsx',
            lineRange: [1, 5],
            domPath: 'div',
            parentChain: [],
            timestamp: 0,
          },
        },
      },
    })
    expect(bad.success).toBe(false)
  })
})
