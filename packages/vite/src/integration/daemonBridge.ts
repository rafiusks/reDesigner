import { spawn as nodeSpawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

export interface DaemonHandle {
  pid: number
  shutdown(): Promise<void>
  stdout: Readable
  stdin: Writable
  stderr: Readable
}

export interface DaemonBridgeOptions {
  mode: 'auto' | 'required' | 'off'
  port: number
  manifestPath: string
  importer: () => Promise<{
    startDaemon: (opts: { manifestPath: string; port: number }) => Promise<DaemonHandle>
  }>
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void }
  /** Injectable spawn (for taskkill test seams). */
  spawn?: typeof nodeSpawn
}

const REQUIRED_HANDLE_KEYS = ['pid', 'shutdown', 'stdout', 'stdin', 'stderr'] as const

export class DaemonBridge {
  private handle: DaemonHandle | null = null
  private shutdownCalled = false
  private signalHandlers: Array<{ signal: NodeJS.Signals; fn: () => void }> = []

  async start(opts: DaemonBridgeOptions): Promise<void> {
    if (opts.mode === 'off') return
    let mod: Awaited<ReturnType<typeof opts.importer>>
    try {
      mod = await opts.importer()
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      const message = (err as Error | undefined)?.message ?? String(err)
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
        if (opts.mode === 'required') {
          throw new Error(`[redesigner] daemon required but not installed: ${message}`)
        }
        opts.logger.warn(
          '[redesigner] daemon package not installed — running in manifest-only mode',
        )
        return
      }
      const stack = (err as Error | undefined)?.stack ?? String(err)
      opts.logger.warn(`[redesigner] daemon package errored on import (continuing): ${stack}`)
      return
    }

    // Validate contract
    const handle = await mod.startDaemon({ manifestPath: opts.manifestPath, port: opts.port })
    const handleRecord = handle as unknown as Record<string, unknown>
    for (const key of REQUIRED_HANDLE_KEYS) {
      const value = handleRecord[key]
      if (value === undefined || value === null) {
        throw new Error(`[redesigner] daemon handle missing required field "${key}"`)
      }
    }

    // Pipe drain
    handle.stdout.on('data', (buf: Buffer) =>
      opts.logger.info(`[daemon] ${buf.toString().trimEnd()}`),
    )
    handle.stderr.on('data', (buf: Buffer) =>
      opts.logger.warn(`[daemon] ${buf.toString().trimEnd()}`),
    )
    this.handle = handle

    // Teardown signals
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
    if (process.platform !== 'win32') signals.push('SIGHUP')
    for (const sig of signals) {
      const fn = () => {
        void this.shutdown(opts)
      }
      process.on(sig, fn)
      this.signalHandlers.push({ signal: sig, fn })
    }
  }

  async shutdown(opts: DaemonBridgeOptions): Promise<void> {
    if (this.shutdownCalled) return
    this.shutdownCalled = true
    for (const { signal, fn } of this.signalHandlers) process.off(signal, fn)
    this.signalHandlers = []
    const h = this.handle
    if (!h) return
    if (process.platform === 'win32') {
      await this.shutdownWindows(h, opts)
    } else {
      await this.shutdownPosix(h, opts)
    }
    this.handle = null
  }

  private async shutdownPosix(h: DaemonHandle, opts: DaemonBridgeOptions): Promise<void> {
    try {
      process.kill(h.pid, 'SIGTERM')
    } catch {}
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2000)
      h.stdout.once('end', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (!exited) {
      try {
        process.kill(h.pid, 'SIGKILL')
      } catch {}
      opts.logger.warn('[redesigner] daemon did not exit on SIGTERM; escalated to SIGKILL')
    }
  }

  private async shutdownWindows(h: DaemonHandle, opts: DaemonBridgeOptions): Promise<void> {
    const spawn = opts.spawn ?? nodeSpawn
    let acked = false
    const ackPromise = new Promise<void>((resolve) => {
      const onData = (buf: Buffer) => {
        if (buf.toString().includes('"ack":true')) {
          acked = true
          resolve()
        }
      }
      h.stdout.on('data', onData)
      setTimeout(() => {
        h.stdout.off('data', onData)
        resolve()
      }, 1500)
    })
    try {
      h.stdin.write('{"op":"shutdown"}\n')
    } catch {
      /* missing stdin → straight to taskkill */
    }
    await ackPromise
    if (acked) {
      const exited = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 1500)
        h.stdout.once('end', () => {
          clearTimeout(t)
          resolve(true)
        })
      })
      if (exited) return
    }
    const tk = spawn('taskkill', ['/T', '/F', '/PID', String(h.pid)])
    const ok = await new Promise<boolean>((resolve) =>
      tk.on('close', (code: number | null) => resolve(code === 0)),
    )
    if (!ok) {
      opts.logger.warn(
        `[redesigner] taskkill non-zero exit for PID ${h.pid}; manual cleanup may be required`,
      )
    }
  }
}
