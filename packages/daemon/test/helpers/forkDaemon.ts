/**
 * Shared fork-and-boot harness for daemon integration tests.
 *
 * Forks the built `packages/daemon/dist/child.js`, awaits the JSON ready line
 * on stdout, discovers the handoff file, and returns a harness the test can
 * use to hit REST + WS against the real daemon process.
 *
 * Extracted from endToEnd.test.ts so that multiple integration files
 * (endToEnd, manifestHmr, ...) share one implementation. Keep this file
 * free of test-specific state — it must be a pure helper.
 */

import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import { HandoffSchema, discoverHandoff, resolveHandoffPath } from '../../src/handoff.js'
import { randomTempDir } from './randomTempDir.js'

// ---------------------------------------------------------------------------
// Platform-timed constants
// ---------------------------------------------------------------------------

const READY_TIMEOUT_MS = process.platform === 'win32' ? 10_000 : 2_000

// ---------------------------------------------------------------------------
// Paths to built artefacts
// ---------------------------------------------------------------------------

// import.meta.dirname is available on Node ≥22 per package engines.
const HELPERS_DIR = import.meta.dirname
const PACKAGE_DIR = path.resolve(HELPERS_DIR, '..', '..')
export const CHILD_JS = path.join(PACKAGE_DIR, 'dist', 'child.js')

// ---------------------------------------------------------------------------
// Harness shape
// ---------------------------------------------------------------------------

export interface DaemonHarness {
  child: ChildProcess
  projectRoot: string
  manifestPath: string
  manifestDir: string
  handoffPath: string
  port: number
  instanceId: string
  token: string
  urlPrefix: string
  authHeader: string
}

// ---------------------------------------------------------------------------
// Minimal valid manifest
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid manifest object. The `contentHash` field is ignored by
 * ManifestWatcher (it recomputes from raw bytes), but the schema requires a
 * valid 64-char hex string. `extra` is merged in so callers can differentiate
 * manifests by e.g. `generatedAt`.
 */
export function buildMinimalManifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    framework: 'react',
    generatedAt: new Date().toISOString(),
    contentHash: '0'.repeat(64),
    components: {
      'src/App.tsx::App': {
        filePath: 'src/App.tsx',
        exportKind: 'default' as const,
        lineRange: [1, 10],
        displayName: 'App',
      },
    },
    locs: {},
    ...extra,
  }
}

/**
 * Write a minimal valid manifest to `manifestPath`, creating parent dirs and
 * using 0600 mode (matches daemon expectations). Returns the serialized bytes.
 */
export function seedManifest(manifestPath: string, extra: Record<string, unknown> = {}): string {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  const raw = JSON.stringify(buildMinimalManifest(extra))
  fs.writeFileSync(manifestPath, raw, { mode: 0o600 })
  return raw
}

/**
 * Atomic temp+rename write pattern. Matches the write style of the real
 * manifest emitter (write to sibling `.tmp`, then rename to final path).
 */
export function atomicWriteManifest(
  manifestPath: string,
  extra: Record<string, unknown> = {},
): string {
  const raw = JSON.stringify(buildMinimalManifest(extra))
  const tmp = `${manifestPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  fs.writeFileSync(tmp, raw, { mode: 0o600 })
  fs.renameSync(tmp, manifestPath)
  return raw
}

// ---------------------------------------------------------------------------
// Fork + ready harness
// ---------------------------------------------------------------------------

export interface SpawnDaemonOptions {
  /** Prefix for randomTempDir. Defaults to 'redesigner-daemon-'. */
  tempDirPrefix?: string
  /** If true, seed a minimal manifest before fork. Defaults to true. */
  seedManifestBeforeFork?: boolean
}

/**
 * Fork dist/child.js, await the `{type:'ready',port,instanceId}` JSON line on
 * stdout, discover+validate the handoff file, and return a harness.
 *
 * Callers are responsible for teardown: they MUST pass the returned `child`
 * through `forceKill()` or similar in afterEach. `cleanupTempDirs()` should
 * also be invoked in afterEach to clean `projectRoot`.
 */
export async function spawnDaemon(opts: SpawnDaemonOptions = {}): Promise<DaemonHarness> {
  const { tempDirPrefix = 'redesigner-daemon-', seedManifestBeforeFork = true } = opts

  if (!fs.existsSync(CHILD_JS)) {
    throw new Error(
      `built child entry missing at ${CHILD_JS}; run \`pnpm --filter @redesigner/daemon build\` first`,
    )
  }

  const projectRoot = randomTempDir(tempDirPrefix)
  const realProjectRoot = fs.realpathSync(projectRoot)
  const manifestDir = path.join(realProjectRoot, '.redesigner')
  const manifestPath = path.join(manifestDir, 'manifest.json')
  if (seedManifestBeforeFork) seedManifest(manifestPath)
  const handoffPath = resolveHandoffPath(realProjectRoot)

  const child = fork(CHILD_JS, [], {
    env: {
      ...process.env,
      REDESIGNER_MANIFEST_PATH: manifestPath,
      REDESIGNER_DAEMON_VERSION: '0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })

  let ready: { port: number; instanceId: string } | null = null
  let stdoutBuf = ''
  let stderrBuf = ''

  const readyPromise = new Promise<{ port: number; instanceId: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `ready line not received within ${READY_TIMEOUT_MS}ms; ` +
            `stdout=${JSON.stringify(stdoutBuf)} stderr=${JSON.stringify(stderrBuf)}`,
        ),
      )
    }, READY_TIMEOUT_MS)
    timer.unref()

    const onStdout = (chunk: Buffer): void => {
      stdoutBuf += chunk.toString('utf8')
      let nl = stdoutBuf.indexOf('\n')
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl).trim()
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (line.length > 0) {
          try {
            const parsed = JSON.parse(line) as {
              type?: unknown
              port?: unknown
              instanceId?: unknown
            }
            if (
              parsed.type === 'ready' &&
              typeof parsed.port === 'number' &&
              typeof parsed.instanceId === 'string'
            ) {
              clearTimeout(timer)
              child.stdout?.off('data', onStdout)
              child.stderr?.off('data', onStderr)
              ready = { port: parsed.port, instanceId: parsed.instanceId }
              resolve(ready)
              return
            }
          } catch {
            // Non-JSON line — ignore.
          }
        }
        nl = stdoutBuf.indexOf('\n')
      }
    }
    const onStderr = (chunk: Buffer): void => {
      stderrBuf += chunk.toString('utf8')
    }
    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    child.once('exit', (code, signal) => {
      if (ready === null) {
        clearTimeout(timer)
        reject(
          new Error(`child exited before ready: code=${code} signal=${signal} stderr=${stderrBuf}`),
        )
      }
    })
  })

  const { port, instanceId } = await readyPromise

  const discovery = discoverHandoff(realProjectRoot)
  if (!discovery) {
    throw new Error(`handoff not discoverable at ${handoffPath}`)
  }
  const validated = HandoffSchema.parse(discovery.parsed)
  expect(validated.instanceId).toBe(instanceId)
  expect(validated.port).toBe(port)

  return {
    child,
    projectRoot: realProjectRoot,
    manifestPath,
    manifestDir,
    handoffPath,
    port,
    instanceId,
    token: discovery.parsed.token,
    urlPrefix: discovery.urlPrefix,
    authHeader: discovery.authHeader,
  }
}

/**
 * Force-kill a child process if still alive; wait for exit. Used in afterEach
 * so a failed test cannot leak a daemon process.
 */
export async function forceKill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    try {
      child.kill('SIGKILL')
    } catch {
      resolve()
    }
  })
}
