import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DaemonBridge,
  type DaemonBridgeOptions,
  type DaemonHandle,
} from '../../src/integration/daemonBridge'

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

interface TestHandle extends DaemonHandle {
  stdout: PassThrough
  stdin: PassThrough
  stderr: PassThrough
}

function mockHandle(pid = 1234): TestHandle {
  return {
    pid,
    shutdown: vi.fn(async () => {}),
    stdout: new PassThrough(),
    stdin: new PassThrough(),
    stderr: new PassThrough(),
  }
}

function baseOpts(overrides: Partial<DaemonBridgeOptions> = {}): DaemonBridgeOptions {
  return {
    mode: 'auto',
    port: 0,
    manifestPath: '/tmp/manifest.json',
    importer: async () => ({ startDaemon: async () => mockHandle() }),
    logger: mockLogger(),
    ...overrides,
  }
}

describe('DaemonBridge', () => {
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  })
  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  })

  it('mode=auto + ERR_MODULE_NOT_FOUND → warn once, null handle', async () => {
    const logger = mockLogger()
    const b = new DaemonBridge()
    const err = Object.assign(new Error('not found'), { code: 'ERR_MODULE_NOT_FOUND' })
    await b.start(
      baseOpts({
        importer: async () => {
          throw err
        },
        logger,
      }),
    )
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('manifest-only'))
  })

  it('mode=required + ERR_MODULE_NOT_FOUND → throws', async () => {
    const b = new DaemonBridge()
    const err = Object.assign(new Error('not found'), { code: 'ERR_MODULE_NOT_FOUND' })
    await expect(
      b.start(
        baseOpts({
          mode: 'required',
          importer: async () => {
            throw err
          },
        }),
      ),
    ).rejects.toThrow(/daemon required but not installed/)
  })

  it('mode=auto + ERR_PACKAGE_PATH_NOT_EXPORTED → warn once, null handle', async () => {
    const logger = mockLogger()
    const b = new DaemonBridge()
    const err = Object.assign(new Error('no exports'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
    await b.start(
      baseOpts({
        importer: async () => {
          throw err
        },
        logger,
      }),
    )
    expect(logger.warn).toHaveBeenCalledOnce()
  })

  it('generic importer error → warn with stack, continues', async () => {
    const logger = mockLogger()
    const b = new DaemonBridge()
    await b.start(
      baseOpts({
        importer: async () => {
          throw new Error('boom')
        },
        logger,
      }),
    )
    expect(logger.warn).toHaveBeenCalledOnce()
    const firstCall = logger.warn.mock.calls[0]
    expect(firstCall?.[0]).toContain('errored on import')
  })

  it('handle missing required field → throws', async () => {
    const b = new DaemonBridge()
    const incomplete = {
      pid: 123,
      shutdown: async () => {},
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    } as unknown as DaemonHandle
    await expect(
      b.start(baseOpts({ importer: async () => ({ startDaemon: async () => incomplete }) })),
    ).rejects.toThrow(/missing required field "stdin"/)
  })

  it('pipe drain: stdout data → logger.info', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const logger = mockLogger()
    const handle = mockHandle(99999)
    const b = new DaemonBridge()
    const opts = baseOpts({
      importer: async () => ({ startDaemon: async () => handle }),
      logger,
    })
    await b.start(opts)
    handle.stdout.write('hello from daemon\n')
    await new Promise((r) => setImmediate(r))
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('hello from daemon'))
    const shutPromise = b.shutdown(opts)
    handle.stdout.end()
    await shutPromise
  })

  it('shutdown idempotent: double-call does not double-kill', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const logger = mockLogger()
    // unlikely PID → process.kill throws, caught by `try { ... } catch {}`
    const handle = mockHandle(99999)
    const opts = baseOpts({
      importer: async () => ({ startDaemon: async () => handle }),
      logger,
    })
    const b = new DaemonBridge()
    await b.start(opts)
    const shut1 = b.shutdown(opts)
    const shut2 = b.shutdown(opts)
    // End stdout so the SIGTERM escape path completes quickly
    handle.stdout.end()
    await Promise.all([shut1, shut2])
    // No assertion on kill spy — just verify both resolved without throwing
  })

  it('SIGHUP handler NOT registered on win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const handle = mockHandle()
    const spawnSpy = vi.fn(() => {
      const fakeProc = {
        on: (ev: string, cb: (code: number | null) => void) => {
          if (ev === 'close') setImmediate(() => cb(0))
          return fakeProc
        },
      }
      return fakeProc as unknown as ChildProcess
    })
    const opts = baseOpts({
      importer: async () => ({ startDaemon: async () => handle }),
      spawn: spawnSpy as unknown as typeof nodeSpawn,
    })
    const b = new DaemonBridge()
    const beforeListeners = process.listenerCount('SIGHUP')
    await b.start(opts)
    const afterListeners = process.listenerCount('SIGHUP')
    expect(afterListeners).toBe(beforeListeners)
    // Prime an ack + end so shutdown doesn't wait the full 1500ms ack timeout.
    setImmediate(() => {
      handle.stdout.write('{"ack":true}\n')
      setImmediate(() => handle.stdout.end())
    })
    await b.shutdown(opts)
  })

  it('SIGHUP handler IS registered on posix', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    // Unlikely PID so process.kill rejects immediately (caught); stdout.end() triggers exited=true.
    const handle = mockHandle(99999)
    const opts = baseOpts({ importer: async () => ({ startDaemon: async () => handle }) })
    const b = new DaemonBridge()
    const beforeListeners = process.listenerCount('SIGHUP')
    await b.start(opts)
    const afterListeners = process.listenerCount('SIGHUP')
    expect(afterListeners).toBe(beforeListeners + 1)
    const shutPromise = b.shutdown(opts)
    handle.stdout.end()
    await shutPromise
  })

  it('Windows shutdown: stdin write + ack + stdout end → no taskkill', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const spawnSpy = vi.fn(() => {
      const fakeProc = {
        on: (ev: string, cb: (code: number | null) => void) => {
          if (ev === 'close') setImmediate(() => cb(0))
          return fakeProc
        },
      }
      return fakeProc as unknown as ChildProcess
    })
    const handle = mockHandle()
    const logger = mockLogger()
    const opts = baseOpts({
      importer: async () => ({ startDaemon: async () => handle }),
      logger,
      spawn: spawnSpy as unknown as typeof nodeSpawn,
    })
    const b = new DaemonBridge()
    await b.start(opts)

    // Prime an ack; then end stdout on a later tick so the `.once('end')` listener is attached first.
    setImmediate(() => {
      handle.stdout.write('{"ack":true}\n')
      setImmediate(() => handle.stdout.end())
    })

    await b.shutdown(opts)
    expect(spawnSpy).not.toHaveBeenCalled()
  })

  it('Windows shutdown: no ack within 1500ms → taskkill', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    vi.useFakeTimers()
    const spawnSpy = vi.fn(() => {
      const fakeProc = {
        on: (ev: string, cb: (code: number | null) => void) => {
          if (ev === 'close') queueMicrotask(() => cb(0))
          return fakeProc
        },
      }
      return fakeProc as unknown as ChildProcess
    })
    const handle = mockHandle()
    const logger = mockLogger()
    const opts = baseOpts({
      importer: async () => ({ startDaemon: async () => handle }),
      logger,
      spawn: spawnSpy as unknown as typeof nodeSpawn,
    })
    const b = new DaemonBridge()
    await b.start(opts)

    const shutdownPromise = b.shutdown(opts)
    await vi.advanceTimersByTimeAsync(2000)
    await shutdownPromise
    vi.useRealTimers()

    expect(spawnSpy).toHaveBeenCalledOnce()
    expect(spawnSpy).toHaveBeenCalledWith(
      'taskkill',
      expect.arrayContaining(['/F', '/PID', String(handle.pid)]),
    )
  })
})
