// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRegisterEnvelope } from '../../src/content/register.js'
import { createRpcAgent } from '../../src/content/rpcAgent.js'
import { CsRegisterMessageSchema } from '../../src/shared/messages.js'
import { makeChromeMock } from '../chromeMock/index.js'

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

type PortWithTestHooks = chrome.runtime.Port & {
  onMessage: chrome.events.Event<(message: unknown) => void> & {
    _listeners: ((msg: unknown) => void)[]
    _emit: (msg: unknown) => void
  }
  onDisconnect: chrome.events.Event<() => void> & {
    _listeners: (() => void)[]
    _emit: () => void
  }
}

const VALID_ARGS = {
  wsUrl: 'ws://127.0.0.1:5555/events',
  httpUrl: 'http://127.0.0.1:5555',
  bootstrapToken: 'tok-abc',
  editor: 'vscode' as const,
}

describe('buildRegisterEnvelope', () => {
  it('(1) returns schema-valid envelope with type register and UUID clientId', () => {
    const env = buildRegisterEnvelope(VALID_ARGS)
    expect(() => CsRegisterMessageSchema.parse(env)).not.toThrow()
    expect(env.type).toBe('register')
    expect(env.clientId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  it('(2) multiple calls produce distinct clientIds', () => {
    const a = buildRegisterEnvelope(VALID_ARGS)
    const b = buildRegisterEnvelope(VALID_ARGS)
    expect(a.clientId).not.toBe(b.clientId)
  })

  it('(3) fields are passed through unchanged', () => {
    const env = buildRegisterEnvelope(VALID_ARGS)
    expect(env.wsUrl).toBe(VALID_ARGS.wsUrl)
    expect(env.httpUrl).toBe(VALID_ARGS.httpUrl)
    expect(env.bootstrapToken).toBe(VALID_ARGS.bootstrapToken)
    expect(env.editor).toBe(VALID_ARGS.editor)
  })
})

describe('createRpcAgent', () => {
  let chromeMock: ReturnType<typeof makeChromeMock>
  let capturedPort: PortWithTestHooks | null

  beforeEach(() => {
    vi.useFakeTimers()
    chromeMock = makeChromeMock()
    capturedPort = null

    const originalConnect = chromeMock.runtime.connect.bind(chromeMock.runtime)
    vi.spyOn(chromeMock.runtime, 'connect').mockImplementation(
      (connectInfo?: { name?: string }) => {
        const port = originalConnect(connectInfo)
        capturedPort = port as PortWithTestHooks
        return port
      },
    )

    // @ts-expect-error assign mock chrome in test environment
    globalThis.chrome = chromeMock
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('(4) start() calls chrome.runtime.connect with the rpc port name', () => {
    const agent = createRpcAgent()
    agent.start()
    expect(chromeMock.runtime.connect).toHaveBeenCalledWith({ name: 'redesigner-rpc' })
    agent.stop()
  })

  it('(5) incoming rpc.request runs handler and posts rpc.reply with matching id', async () => {
    const handler = vi.fn().mockResolvedValue({ count: 3 })
    const agent = createRpcAgent({ handler })
    agent.start()

    expect(capturedPort).not.toBeNull()

    chromeMock._recorder.clear()
    capturedPort?.onMessage._emit({
      type: 'rpc.request',
      id: 'req-1',
      method: 'dom.querySelectorAll',
      params: { selector: 'div' },
    })

    await tick(0)

    const effects = chromeMock._recorder.snapshot()
    const replies = effects.filter(
      (e) =>
        e.type === 'runtime.port.postMessage' &&
        ((e.args as Record<string, unknown>)?.msg as Record<string, unknown>)?.type === 'rpc.reply',
    )
    expect(replies.length).toBeGreaterThanOrEqual(1)
    const replyMsg = (replies[replies.length - 1]?.args as Record<string, unknown>)?.msg as Record<
      string,
      unknown
    >
    expect(replyMsg?.id).toBe('req-1')
    expect(replyMsg?.result).toEqual({ count: 3 })
    agent.stop()
  })

  it('(6) handler rejection posts rpc.error with matching id', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('boom'))
    const agent = createRpcAgent({ handler })
    agent.start()

    expect(capturedPort).not.toBeNull()

    chromeMock._recorder.clear()
    capturedPort?.onMessage._emit({
      type: 'rpc.request',
      id: 'req-2',
      method: 'dom.querySelectorAll',
      params: { selector: 'span' },
    })

    await tick(0)

    const effects = chromeMock._recorder.snapshot()
    const errorReplies = effects.filter(
      (e) =>
        e.type === 'runtime.port.postMessage' &&
        ((e.args as Record<string, unknown>)?.msg as Record<string, unknown>)?.type === 'rpc.error',
    )
    expect(errorReplies.length).toBeGreaterThanOrEqual(1)
    const errMsg = (errorReplies[errorReplies.length - 1]?.args as Record<string, unknown>)
      ?.msg as Record<string, unknown>
    expect(errMsg?.id).toBe('req-2')
    expect(typeof errMsg?.code).toBe('string')
    expect(typeof errMsg?.message).toBe('string')
    agent.stop()
  })

  it('(7) setArmed(true) sends heartbeats every 2000ms', async () => {
    const agent = createRpcAgent({ armedHeartbeatMs: 2000 })
    agent.start()
    agent.setArmed(true)

    chromeMock._recorder.clear()
    await tick(2000)

    const effects = chromeMock._recorder.snapshot()
    const heartbeats = effects.filter(
      (e) =>
        e.type === 'runtime.port.postMessage' &&
        ((e.args as Record<string, unknown>)?.msg as Record<string, unknown>)?.type === 'heartbeat',
    )
    expect(heartbeats.length).toBeGreaterThanOrEqual(1)
    const hb = (heartbeats[0]?.args as Record<string, unknown>)?.msg as Record<string, unknown>
    expect(hb?.armed).toBe(true)
    expect(typeof hb?.t).toBe('number')

    agent.stop()
  })

  it('(8) setArmed(false) stops heartbeat', async () => {
    const agent = createRpcAgent({ armedHeartbeatMs: 2000 })
    agent.start()
    agent.setArmed(true)
    agent.setArmed(false)

    chromeMock._recorder.clear()
    await tick(4000)

    const effects = chromeMock._recorder.snapshot()
    const heartbeats = effects.filter(
      (e) =>
        e.type === 'runtime.port.postMessage' &&
        ((e.args as Record<string, unknown>)?.msg as Record<string, unknown>)?.type === 'heartbeat',
    )
    expect(heartbeats).toHaveLength(0)
    agent.stop()
  })

  it('(9) port disconnect stops heartbeat', async () => {
    const agent = createRpcAgent({ armedHeartbeatMs: 2000 })
    agent.start()
    agent.setArmed(true)

    expect(capturedPort).not.toBeNull()
    capturedPort?.onDisconnect._emit()

    chromeMock._recorder.clear()
    await tick(4000)

    const effects = chromeMock._recorder.snapshot()
    const heartbeats = effects.filter(
      (e) =>
        e.type === 'runtime.port.postMessage' &&
        ((e.args as Record<string, unknown>)?.msg as Record<string, unknown>)?.type === 'heartbeat',
    )
    expect(heartbeats).toHaveLength(0)
  })

  it('(10) clientId: first message after connect is hello with UUID clientId', () => {
    const agent = createRpcAgent()
    agent.start()

    const effects = chromeMock._recorder.snapshot()
    const hellos = effects.filter(
      (e) =>
        e.type === 'runtime.port.postMessage' &&
        ((e.args as Record<string, unknown>)?.msg as Record<string, unknown>)?.type === 'hello',
    )
    expect(hellos.length).toBeGreaterThanOrEqual(1)
    const helloMsg = (hellos[0]?.args as Record<string, unknown>)?.msg as Record<string, unknown>
    expect(typeof helloMsg?.clientId).toBe('string')
    expect(helloMsg?.clientId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    agent.stop()
  })
})
