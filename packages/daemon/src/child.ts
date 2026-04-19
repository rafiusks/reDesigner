import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildHandoff, resolveHandoffPath, writeHandoff } from './handoff.js'
import { shutdownGracefully } from './lifecycle.js'
import { createLogger } from './logger.js'
import { createDaemonServer } from './server.js'
import { EventBus } from './state/eventBus.js'
import { ManifestWatcher } from './state/manifestWatcher.js'
import { SelectionState } from './state/selectionState.js'
import type { RouteContext } from './types.js'
import { RpcCorrelation } from './ws/rpcCorrelation.js'

export interface ChildBootOptions {
  manifestPath: string
  serverVersion: string
}

export function serializeReadyLine(opts: { port: number; instanceId: string }): string {
  return `${JSON.stringify({ type: 'ready', port: opts.port, instanceId: opts.instanceId })}\n`
}

async function main(): Promise<void> {
  // Step 1: env + derive projectRoot.
  const manifestPath = process.env.REDESIGNER_MANIFEST_PATH
  if (!manifestPath) {
    process.stderr.write('REDESIGNER_MANIFEST_PATH env required\n')
    process.exit(1)
  }
  // .redesigner/manifest.json → projectRoot (parent of parent).
  const projectRoot = path.dirname(path.dirname(manifestPath))
  const serverVersion = process.env.REDESIGNER_DAEMON_VERSION ?? '0.0.1'

  // Step 2: resolve handoff path (does not create it).
  const handoffPath = resolveHandoffPath(projectRoot)

  // Step 3: logger.
  const logger = createLogger({
    file: path.join(path.dirname(manifestPath), 'daemon.log'),
    maxBytes: 10 * 1024 * 1024,
  })

  // Step 4: pre-listen state.
  const selectionState = new SelectionState()
  const eventBus = new EventBus()
  const rpcCorrelation = new RpcCorrelation(8)

  const manifestWatcher = new ManifestWatcher(
    manifestPath,
    (m) => {
      const resolution = selectionState.rescan(m)
      if (resolution.resolvedCount > 0) {
        eventBus.broadcast({
          type: 'staleManifest.resolved',
          payload: { count: resolution.resolvedCount },
        })
      }
      eventBus.broadcast({
        type: 'manifest.updated',
        payload: { contentHash: m.contentHash, componentCount: Object.keys(m.components).length },
      })
    },
    fs.promises.readFile,
    fs.promises.stat,
    logger,
  )

  // Step 5: token + instanceId.
  const token = crypto.randomBytes(32).toString('base64url')
  const instanceId = crypto.randomUUID()

  // Step 6: discover ephemeral port; assert strict loopback + integer port.
  // Task 13 smoke-test learning: server needs port at construction for Host check,
  // so bind a throwaway server first to discover a port, close it, and hand the
  // port to createDaemonServer for listen.
  const port = await new Promise<number>((resolve, reject) => {
    const tmpServer = http.createServer(() => {})
    tmpServer.on('error', reject)
    tmpServer.listen(0, '127.0.0.1', () => {
      const addr = tmpServer.address()
      if (
        !addr ||
        typeof addr === 'string' ||
        addr.address !== '127.0.0.1' ||
        !Number.isInteger(addr.port) ||
        addr.port <= 0 ||
        addr.port >= 65536
      ) {
        reject(new Error('bind address mismatch'))
        return
      }
      const discoveredPort = addr.port
      tmpServer.close(() => resolve(discoveredPort))
    })
  })

  // Step 7: warm manifest cache before accepting requests.
  await manifestWatcher.start()

  // Step 9 (hoisted): shutdown closure referenced by ctx.shutdown and signal handlers.
  // The `daemon` binding is initialized below; this closure captures it by reference
  // via the outer variable, so it's safe as long as we don't call shutdown before
  // the assignment. The only paths to shutdown here are post-listen (signals, IPC
  // disconnect, ppid change) — all of which fire strictly after daemon is set.
  let daemon: ReturnType<typeof createDaemonServer> | null = null
  const shutdown = async (reason: string): Promise<void> => {
    if (!daemon) {
      // Shouldn't happen — boot aborts before any shutdown trigger is wired.
      process.exit(1)
    }
    await shutdownGracefully(
      {
        server: daemon.server,
        manifestWatcher,
        rpcCorrelation,
        eventBus,
        handoffPath,
        logger,
        drainDeadlineMs: 100,
      },
      reason,
    )
    process.exit(0)
  }

  // Step 8: RouteContext — shutdown wired per step 10.
  const ctx: RouteContext = {
    selectionState,
    manifestWatcher,
    eventBus,
    rpcCorrelation,
    logger,
    serverVersion,
    instanceId,
    startedAt: Date.now(),
    projectRoot,
    shutdown: () => shutdown('/shutdown'),
  }

  // Step 11: construct real server on discovered port and listen.
  daemon = createDaemonServer({ port, token: Buffer.from(token, 'utf8'), ctx })
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err)
    daemon?.server.once('error', onError)
    daemon?.server.listen(port, '127.0.0.1', () => {
      daemon?.server.removeListener('error', onError)
      resolve()
    })
  })

  // Step 12: write handoff (atomic, 0600). Close fd immediately after write.
  const handoff = buildHandoff({
    serverVersion,
    pid: process.pid,
    port,
    token,
    projectRoot,
    instanceId,
  })
  const { fd } = writeHandoff(handoffPath, handoff)
  fs.closeSync(fd)

  // Step 13: IPC disconnect wiring, then unref channel.
  // Load-bearing: unref() AFTER the disconnect listener is registered. Also:
  // NO further `process.on('message', ...)` listener anywhere — would silently re-ref.
  process.on('disconnect', () => {
    void shutdown('parent disconnect')
  })
  process.channel?.unref()

  // Step 14: POSIX-only ppid poll (1s). Unref so it doesn't pin the event loop.
  const initialPpid = process.ppid
  if (process.platform !== 'win32') {
    const ppidPoll = setInterval(() => {
      if (process.ppid !== initialPpid) {
        clearInterval(ppidPoll)
        void shutdown('ppid changed')
      }
    }, 1000)
    ppidPoll.unref()
  }

  // Step 15: signal handlers.
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })

  // Step 16: partial-write-safe ready line on stdout.
  const rl = Buffer.from(serializeReadyLine({ port, instanceId }), 'utf8')
  let o = 0
  while (o < rl.length) {
    o += fs.writeSync(1, rl, o, rl.length - o)
  }

  // Step 17: log startup with realpath'd handoff + pid.
  logger.info('[daemon] ready', {
    pid: process.pid,
    port,
    instanceId,
    handoffPath: fs.realpathSync(handoffPath),
  })
}

// Only run when loaded as fork entry — importing the module (e.g. from unit tests)
// must not execute main().
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    process.stderr.write(`[daemon] boot failed: ${err}\n`)
    process.exit(1)
  })
}
