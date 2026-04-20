/**
 * Integration test for Slice D of the Selection Pipeline:
 *
 *   ext → daemon PUT /tabs/:tabId/selection
 *     └─► daemon SelectionState
 *           └─► MCP CLI GET /selection (via DaemonBackend)
 *                 └─► MCP tool `get_current_selection`
 *
 * This test is intentionally self-contained:
 *   1. Spins up `createDaemonServer` on an ephemeral port in-process (no fork).
 *   2. Writes a fake handoff file at the EXACT path the MCP DaemonBackend's
 *      `resolveHandoffPath` will look at (replicated from
 *      packages/mcp/src/daemonBackend.ts lines 65-90 — must not import).
 *   3. PUTs a selection to the daemon with `Authorization: Bearer <rootToken>`.
 *   4. Spawns `packages/mcp/dist/cli.js` as a child process via
 *      `StdioClientTransport`.
 *   5. Calls MCP tools and asserts the handle round-trips.
 *
 * SDK API note: `StdioClientTransport` only exposes the `{command, args}`
 * constructor form (confirmed in
 * packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.d.ts).
 * There is no way to pass pre-spawned streams, so the SDK owns the child's
 * lifecycle. We rely on a 1s reap ceiling on `transport.close()` plus a dual
 * `exit`/`beforeExit` guard on the test process itself to catch any orphaned
 * PID. `transport.pid` is used by the guards for a per-test liveness probe.
 *
 * CLAUDE.md invariants honored:
 *   - `AbortSignal.timeout` (never `new AbortController + setTimeout`).
 *   - ESM imports; `import.meta.dirname` not `__dirname`.
 *   - `@redesigner/core` resolved via compiled dist (only types consumed here).
 *   - All Zod schemas stay module-top-level (no z.object in handlers/tests).
 */

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createDaemonServer } from '../../../daemon/src/server.js'
import { EventBus } from '../../../daemon/src/state/eventBus.js'
import { ManifestWatcher } from '../../../daemon/src/state/manifestWatcher.js'
import { SelectionState } from '../../../daemon/src/state/selectionState.js'
import type { RouteContext } from '../../../daemon/src/types.js'
import { RpcCorrelation } from '../../../daemon/src/ws/rpcCorrelation.js'

// ---------------------------------------------------------------------------
// Paths / constants
// ---------------------------------------------------------------------------

const HERE = import.meta.dirname
const MCP_CLI = path.resolve(HERE, '../../dist/cli.js')
const PKG_ROOT = path.resolve(HERE, '../..')

const FETCH_TIMEOUT_MS = 3_000
const REAP_CEILING_MS = 1_000

// The valid ComponentHandle used throughout. Matches the task spec exactly.
const handle = {
  id: 'sel-1',
  componentName: 'PricingCard',
  filePath: 'src/components/PricingCard.tsx',
  lineRange: [3, 42] as [number, number],
  domPath: 'body > div',
  parentChain: ['App'],
  timestamp: Date.now(),
}

// ---------------------------------------------------------------------------
// Dual exit guards — see vitest#3077 / SDK#579.
//
// The SDK owns the child but its `close()` is best-effort. If a test crashes
// mid-flight (unhandled rejection, test runner kill) the child PID can leak.
// We register BOTH `exit` and `beforeExit` so we catch both the normal flow
// (`beforeEach` completed cleanly, then `beforeExit` fires) and the crash
// flow (`exit` is the last resort).
//
// `childPid` is a module-level mutable holder. `killGuard` does a liveness
// probe first (`kill(pid, 0)`) so PID reuse by the OS can't kill an
// unrelated process:
//   - ESRCH: PID gone; nothing to do.
//   - EPERM: PID exists but isn't ours (reuse case); do NOT kill.
//   - success: PID is ours → SIGKILL.
// After the probe the holder is cleared so subsequent fires are no-ops.
//
// We use positive-PID (not group-kill `-pid`) because the SDK spawns the
// child without `detached: true`, so the child never becomes a process
// group leader, and sending a signal to `-pid` would hit *our* group —
// which includes vitest.
// ---------------------------------------------------------------------------

let childPid: number | null = null

function killGuard(): void {
  if (childPid === null) return
  const pid = childPid
  childPid = null
  // Liveness probe: ESRCH means the PID is gone — don't kill.
  try {
    process.kill(pid, 0)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return
    // EPERM (permission denied) implies the pid exists but isn't ours —
    // probably a reuse case. Do not kill.
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return
    // Silent — worst case the OS reaps it.
  }
}

process.on('exit', killGuard)
process.on('beforeExit', killGuard)

// ---------------------------------------------------------------------------
// Handoff-path derivation — replicated VERBATIM from
// packages/mcp/src/daemonBackend.ts lines 65-90. Do not import; if the MCP
// source drifts, this test must be updated in lockstep.
// ---------------------------------------------------------------------------

function replicatedResolveHandoffPath(projectRoot: string): string {
  let realRoot: string
  try {
    realRoot = fs.realpathSync(projectRoot)
  } catch {
    realRoot = projectRoot
  }
  const projectHash = crypto.createHash('sha256').update(realRoot).digest('hex').slice(0, 16)
  const uid =
    process.platform === 'win32' ? (process.env.USERNAME ?? 'w') : String(process.getuid?.() ?? 'w')
  if (process.platform === 'linux') {
    const root = process.env.XDG_RUNTIME_DIR ?? path.join(os.tmpdir(), `redesigner-${uid}`)
    return path.join(root, 'redesigner', projectHash, 'daemon-v1.json')
  }
  if (process.platform === 'darwin') {
    return path.join(os.tmpdir(), `com.redesigner.${uid}`, projectHash, 'daemon-v1.json')
  }
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  return path.join(base, 'redesigner', uid, projectHash, 'daemon-v1.json')
}

// ---------------------------------------------------------------------------
// Test-local helpers (self-contained — no shared harness)
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

function makeCtx(projectRoot: string): RouteContext {
  const logger = makeLogger()
  const selectionState = new SelectionState()
  const eventBus = new EventBus()
  const rpcCorrelation = new RpcCorrelation(8)
  // Stubbed fs: readFile/stat are never actually called for this test (no
  // manifest is seeded at `/tmp/test-selection-manifest.json`). The daemon's
  // `staleManifest` check reads `manifestWatcher.getCached()`, which returns
  // null when no load has happened — that path does NOT reject the PUT,
  // it just annotates provenance with `staleManifest: true`.
  const manifestWatcher = new ManifestWatcher(
    '/tmp/test-selection-roundtrip-manifest.json',
    () => {},
    vi.fn() as unknown as typeof import('node:fs').promises.readFile,
    vi.fn() as unknown as typeof import('node:fs').promises.stat,
    logger,
  )
  return {
    selectionState,
    manifestWatcher,
    eventBus,
    rpcCorrelation,
    logger,
    serverVersion: '0.0.1',
    instanceId: crypto.randomUUID(),
    startedAt: Date.now() - 1000,
    projectRoot,
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

interface Harness {
  port: number
  authTokenStr: string
  close: () => Promise<void>
  projectRoot: string
  realProjectRoot: string
  handoffPath: string
}

async function spinUpDaemon(projectRoot: string, realProjectRoot: string): Promise<Harness> {
  const authTokenStr = crypto.randomBytes(32).toString('base64url')
  const authTokenBuf = Buffer.from(authTokenStr, 'utf8')
  const bootstrapTokenBuf = Buffer.from(crypto.randomBytes(32).toString('base64url'), 'utf8')
  const rootTokenBuf = Buffer.from(crypto.randomBytes(32))

  // Ephemeral port probe then reuse.
  const probe = createDaemonServer({
    port: 0,
    token: authTokenBuf,
    bootstrapToken: bootstrapTokenBuf,
    rootToken: rootTokenBuf,
    ctx: makeCtx(realProjectRoot),
  })
  await new Promise<void>((resolve) => probe.server.listen(0, '127.0.0.1', () => resolve()))
  const assigned = (probe.server.address() as AddressInfo).port
  await probe.close()

  const real = createDaemonServer({
    port: assigned,
    token: authTokenBuf,
    bootstrapToken: bootstrapTokenBuf,
    rootToken: rootTokenBuf,
    ctx: makeCtx(realProjectRoot),
  })
  await new Promise<void>((resolve) => real.server.listen(assigned, '127.0.0.1', () => resolve()))

  const handoffPath = replicatedResolveHandoffPath(projectRoot)

  return {
    port: assigned,
    authTokenStr,
    close: () => real.close(),
    projectRoot,
    realProjectRoot,
    handoffPath,
  }
}

/**
 * Write handoff file at `handoffPath` with 0600 mode and 0700 parent dirs.
 * MCP's DaemonBackend validates: st.isFile(), st.uid === currentUid, and
 * `(st.mode & 0o077) === 0`. Anything else → handoff rejected as unsafe.
 */
function writeHandoff(
  handoffPath: string,
  serverPort: number,
  token: string,
  projectRoot: string,
  serverPid: number,
): void {
  const dir = path.dirname(handoffPath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // mkdirSync with `mode` respects umask; explicitly chmod to be safe.
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    // Non-fatal: failing to chmod won't break us unless the umask was ≥077.
  }
  const payload = {
    serverVersion: '0.0.1',
    instanceId: crypto.randomUUID(),
    pid: serverPid,
    host: '127.0.0.1',
    port: serverPort,
    token,
    bootstrapToken: crypto.randomBytes(32).toString('base64url'),
    projectRoot,
    startedAt: Date.now(),
  }
  fs.writeFileSync(handoffPath, JSON.stringify(payload), { mode: 0o600 })
  // writeFileSync + `mode` only applies on file creation if umask allows.
  fs.chmodSync(handoffPath, 0o600)
}

/**
 * Seed a minimal valid manifest at projectRoot/.redesigner/manifest.json so
 * the MCP CLI's `resolveConfig` walk-up accepts the temp dir as a project.
 * Also seeds package.json so the walk-up finds it.
 *
 * The manifest includes a component whose filePath and lineRange cover the
 * handle's `PricingCard` — this keeps `staleManifest` false on the daemon
 * side if the manifest is ever actually loaded.
 */
function seedProject(projectRoot: string): void {
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'redesigner-roundtrip-fixture', version: '0.0.0', private: true }),
    { mode: 0o600 },
  )
  const manifestDir = path.join(projectRoot, '.redesigner')
  fs.mkdirSync(manifestDir, { recursive: true })
  const manifest = {
    schemaVersion: '1.0',
    framework: 'react',
    generatedAt: new Date().toISOString(),
    contentHash: '0'.repeat(64),
    components: {
      'src/components/PricingCard.tsx::PricingCard': {
        filePath: handle.filePath,
        exportKind: 'default' as const,
        lineRange: [1, 100],
        displayName: handle.componentName,
      },
    },
    locs: {},
  }
  fs.writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify(manifest), {
    mode: 0o600,
  })
}

// ---------------------------------------------------------------------------
// Build-gate: MCP CLI must exist. Opt-in shell-out build via env var.
// ---------------------------------------------------------------------------

function ensureMcpCliBuilt(): { ok: true } | { ok: false; reason: string } {
  if (fs.existsSync(MCP_CLI)) return { ok: true }
  if (process.env.REDESIGNER_MCP_BUILD_IN_TEST === '1') {
    // argv-array form — no string interpolation into a shell. `spawnSync`
    // without a shell uses execvp semantics, preventing any arg injection.
    const res = spawnSync('pnpm', ['--filter', '@redesigner/mcp', 'build'], {
      cwd: PKG_ROOT,
      stdio: 'inherit',
      env: process.env,
      shell: false,
    })
    if (res.status !== 0) {
      return { ok: false, reason: `build failed with status ${res.status}` }
    }
    if (!fs.existsSync(MCP_CLI)) {
      return { ok: false, reason: `build succeeded but ${MCP_CLI} still missing` }
    }
    return { ok: true }
  }
  return {
    ok: false,
    reason: `MCP CLI not built at ${MCP_CLI}. Run \`pnpm --filter @redesigner/mcp build\` first, or re-run with REDESIGNER_MCP_BUILD_IN_TEST=1 to build automatically.`,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('selection roundtrip: daemon PUT → MCP get_current_selection', () => {
  let h: Harness
  let tmpDir: string
  let realTmpDir: string

  beforeEach(async () => {
    // mkdtempSync returns a symlinked path on macOS (/var/folders/... →
    // /private/var/folders/...); realpath matches what the MCP's
    // DaemonBackend will see after it calls `fs.realpathSync`.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redesigner-sel-rt-'))
    realTmpDir = fs.realpathSync(tmpDir)
    seedProject(realTmpDir)
    h = await spinUpDaemon(tmpDir, realTmpDir)
    // Handoff points at the in-process daemon, using this test's PID since
    // that's the process currently listening on the socket.
    writeHandoff(h.handoffPath, h.port, h.authTokenStr, realTmpDir, process.pid)
  })

  afterEach(async () => {
    // Run guard proactively so the child is dead before we tear down the
    // daemon or delete the tmpdir.
    killGuard()
    try {
      await h.close()
    } catch {}
    // rm can race with child exit on win32; best-effort.
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
    try {
      fs.rmSync(path.dirname(h.handoffPath), { recursive: true, force: true })
    } catch {}
  })

  test('MCP tools see a selection PUT to the daemon', { timeout: 20_000 }, async (ctx) => {
    if (process.platform === 'win32') {
      ctx.skip()
      return
    }

    const gate = ensureMcpCliBuilt()
    if (!gate.ok) {
      ctx.skip()
      // eslint-disable-next-line no-console
      console.log(`[selection-roundtrip] skipped: ${gate.reason}`)
      return
    }

    // -------------------------------------------------------------------
    // 1. PUT the selection to the daemon.
    // -------------------------------------------------------------------
    const putRes = await fetch(`http://127.0.0.1:${h.port}/tabs/1/selection`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${h.authTokenStr}`,
        Host: `127.0.0.1:${h.port}`,
        Connection: 'close',
      },
      body: JSON.stringify({ nodes: [handle] }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    expect(putRes.status, `PUT failed; handoffPath=${h.handoffPath}`).toBe(200)
    const putBody = (await putRes.json()) as Record<string, unknown>
    expect(putBody).toHaveProperty('selectionSeq')
    expect(putBody).toHaveProperty('acceptedAt')

    // -------------------------------------------------------------------
    // 2. Spawn MCP CLI via the SDK's StdioClientTransport.
    //
    // The `{command, args}` constructor form is the only available shape
    // (see stdio.d.ts). We pass --project so the CLI's `resolveConfig`
    // uses our temp project root and thus our handoff file.
    //
    // ENV NOTE: the SDK's `getDefaultEnvironment()` only inherits a
    // hard-coded allow-list (HOME, LOGNAME, PATH, SHELL, TERM, USER on
    // POSIX). This strips TMPDIR, which on macOS makes the subprocess's
    // `os.tmpdir()` fall back to `/tmp` — and the MCP's
    // `resolveHandoffPath` would then look for the handoff under
    // `/tmp/com.redesigner.<uid>/...` instead of the per-user
    // `/var/folders/.../T/com.redesigner.<uid>/...` we wrote it to.
    // Passing the full `process.env` keeps the subprocess's tmpdir
    // consistent with ours and ensures discovery succeeds.
    // -------------------------------------------------------------------
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_CLI, '--project', realTmpDir],
      stderr: 'pipe',
      env: { ...process.env } as Record<string, string>,
    })
    const stderrChunks: string[] = []
    transport.stderr?.on('data', (c: Buffer) => {
      stderrChunks.push(c.toString('utf8'))
    })

    const client = new Client(
      { name: 'redesigner-mcp-selection-roundtrip-test', version: '0.0.1' },
      { capabilities: {} },
    )

    try {
      await client.connect(transport)
      childPid = transport.pid
      expect(childPid, 'SDK did not expose a child pid after connect').not.toBeNull()

      // -----------------------------------------------------------------
      // 3. get_current_selection → handle round-trip
      // -----------------------------------------------------------------
      const curRes = await client.callTool({
        name: 'get_current_selection',
        arguments: {},
      })
      const curContent = curRes.content as Array<{ type: string; text?: string }>
      const current = JSON.parse(curContent[0]?.text ?? 'null') as {
        id?: string
        componentName?: string
        filePath?: string
        lineRange?: [number, number]
      } | null
      if (current === null) {
        // Rich failure diagnostic: print handoff path + stderr so it's
        // obvious when the MCP couldn't find the daemon.
        // eslint-disable-next-line no-console
        console.log('[selection-roundtrip] handoffPath =', h.handoffPath)
        // eslint-disable-next-line no-console
        console.log('[selection-roundtrip] mcp stderr =', stderrChunks.join(''))
      }
      expect(current).not.toBeNull()
      expect(current?.id).toBe(handle.id)
      expect(current?.componentName).toBe(handle.componentName)
      expect(current?.filePath).toBe(handle.filePath)
      expect(current?.lineRange).toEqual(handle.lineRange)

      // -----------------------------------------------------------------
      // 4. list_recent_selections → contains the handle
      // -----------------------------------------------------------------
      const recRes = await client.callTool({
        name: 'list_recent_selections',
        arguments: { n: 10 },
      })
      const recContent = recRes.content as Array<{ type: string; text?: string }>
      const recent = JSON.parse(recContent[0]?.text ?? '[]') as Array<{ id: string }>
      expect(Array.isArray(recent)).toBe(true)
      expect(recent.some((r) => r.id === handle.id)).toBe(true)
    } finally {
      // ---------------------------------------------------------------
      // 5. Cleanup. `client.close()` + `transport.close()` are
      //    best-effort; we race them against a 1s ceiling then fall
      //    back to the killGuard for the process-kill path.
      //
      //    Note: we can't detach the SDK-spawned child (constructor
      //    form doesn't expose that), so this ceiling is the ONLY
      //    thing preventing the test runner from hanging on a stuck
      //    child. 1s is enough for a clean MCP shutdown.
      // ---------------------------------------------------------------
      const close = (async () => {
        try {
          await client.close()
        } catch {}
        try {
          await transport.close()
        } catch {}
      })()
      const timeout = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, REAP_CEILING_MS)
        t.unref()
      })
      await Promise.race([close, timeout])
      killGuard()
    }
  })
})
