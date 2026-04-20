import { now as defaultNow } from '../shared/clock.js'

export const RPC_PORT_NAME = 'redesigner-rpc'

export type RpcHandlerFn = (method: string, params: unknown) => Promise<unknown>

export interface RpcAgent {
  start(): void
  stop(): void
  isRunning(): boolean
  setArmed(armed: boolean): void
}

type SwToCs =
  | { type: 'rpc.request'; id: string; method: string; params: unknown }
  | { type: 'arm'; armed: boolean }

type CsToSw =
  | { type: 'rpc.reply'; id: string; result: unknown }
  | { type: 'rpc.error'; id: string; code: string; message: string }
  | { type: 'heartbeat'; armed: boolean; t: number }
  | { type: 'hello'; clientId: string }

async function defaultHandler(method: string, params: unknown): Promise<unknown> {
  if (method === 'dom.querySelectorAll') {
    const { selector } = params as { selector: string }
    return document.querySelectorAll(selector).length
  }
  throw new Error(`Unknown method: ${method}`)
}

export function createRpcAgent(opts?: {
  handler?: RpcHandlerFn
  portName?: string
  armedHeartbeatMs?: number
  now?: () => number
}): RpcAgent {
  const handler = opts?.handler ?? defaultHandler
  const portName = opts?.portName ?? RPC_PORT_NAME
  const armedHeartbeatMs = opts?.armedHeartbeatMs ?? 2000
  const nowFn = opts?.now ?? defaultNow

  let port: chrome.runtime.Port | null = null
  let running = false
  let armed = false
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  const clientId = crypto.randomUUID()

  function clearHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  function startHeartbeat(): void {
    clearHeartbeat()
    heartbeatTimer = setInterval(() => {
      if (port) {
        const msg: CsToSw = { type: 'heartbeat', armed, t: nowFn() }
        port.postMessage(msg)
      }
    }, armedHeartbeatMs)
  }

  function handleMessage(msg: unknown): void {
    const m = msg as SwToCs
    if (m.type === 'rpc.request') {
      const { id, method, params } = m
      handler(method, params).then(
        (result) => {
          if (port) {
            const reply: CsToSw = { type: 'rpc.reply', id, result }
            port.postMessage(reply)
          }
        },
        (err: unknown) => {
          if (port) {
            const errMsg: CsToSw = {
              type: 'rpc.error',
              id,
              code: 'HANDLER_ERROR',
              message: err instanceof Error ? err.message : String(err),
            }
            port.postMessage(errMsg)
          }
        },
      )
    }
  }

  function connect(): void {
    port = chrome.runtime.connect({ name: portName })
    const hello: CsToSw = { type: 'hello', clientId }
    port.postMessage(hello)
    port.onMessage.addListener(handleMessage)
    port.onDisconnect.addListener(() => {
      clearHeartbeat()
      port = null
      // TODO: attempt reconnect with backoff
    })
    if (armed) {
      startHeartbeat()
    }
  }

  return {
    start(): void {
      if (running) return
      running = true
      connect()
    },

    stop(): void {
      if (!running) return
      running = false
      clearHeartbeat()
      if (port) {
        port.onMessage.removeListener(handleMessage)
        port = null
      }
    },

    isRunning(): boolean {
      return running
    },

    setArmed(value: boolean): void {
      armed = value
      if (armed) {
        if (port) startHeartbeat()
      } else {
        clearHeartbeat()
      }
    },
  }
}
