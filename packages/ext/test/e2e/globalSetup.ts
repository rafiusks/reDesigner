/**
 * Playwright global setup — spins up the full harness (playground vite dev +
 * forked daemon via @redesigner/vite) when PW_FULL_HARNESS=1.
 *
 * Exports env vars consumed by nightly specs:
 *   PW_DEV_URL           vite dev URL (e.g. http://localhost:5173)
 *   PW_DAEMON_URL        daemon HTTP base (e.g. http://127.0.0.1:<port>)
 *   PW_DAEMON_WS_URL     daemon WS base
 *   PW_DAEMON_TOKEN      daemon bearer (from handoff file)
 *   PW_HARNESS_CHILD_PID pid of spawned vite process (globalTeardown kills)
 *
 * When PW_FULL_HARNESS is unset, this is a no-op and specs short-circuit via
 * their local `requireFullHarness()` gate.
 */

import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HandoffSchema, resolveHandoffPath } from '@redesigner/daemon'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PLAYGROUND_DIR = path.join(REPO_ROOT, 'examples/playground')

const DAEMON_READY_TIMEOUT_MS = 60_000
const DAEMON_POLL_INTERVAL_MS = 200
const VITE_READY_TIMEOUT_MS = 30_000

async function waitForHandoff(handoffPath: string): Promise<{
  port: number
  token: string
  host: string
  instanceId: string
}> {
  const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(handoffPath, 'utf8')
      const parsed = HandoffSchema.safeParse(JSON.parse(raw))
      if (parsed.success) {
        return {
          port: parsed.data.port,
          token: parsed.data.token,
          host: parsed.data.host,
          instanceId: parsed.data.instanceId,
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    await new Promise<void>((r) => setTimeout(r, DAEMON_POLL_INTERVAL_MS))
  }
  throw new Error(
    `harness: daemon handoff did not appear at ${handoffPath} within ${DAEMON_READY_TIMEOUT_MS}ms`,
  )
}

async function waitForViteReady(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () =>
        reject(new Error(`harness: vite did not emit Local URL within ${VITE_READY_TIMEOUT_MS}ms`)),
      VITE_READY_TIMEOUT_MS,
    )
    const onData = (buf: Buffer): void => {
      const s = buf.toString('utf8')
      const match = /Local:\s+(http:\/\/[^\s]+)/.exec(s)
      if (match?.[1]) {
        clearTimeout(deadline)
        child.stdout?.off('data', onData)
        child.stderr?.off('data', onData)
        resolve(match[1].replace(/\/$/, ''))
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
  })
}

export default async function globalSetup(): Promise<void> {
  if (!process.env.PW_FULL_HARNESS) return

  const handoffPath = resolveHandoffPath(PLAYGROUND_DIR)
  // Clear stale handoff from prior runs so the poll latches onto THIS daemon.
  try {
    await fs.unlink(handoffPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  const child = spawn('pnpm', ['exec', 'vite', '--port', '0'], {
    cwd: PLAYGROUND_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, FORCE_COLOR: '0' },
  })
  child.unref()

  child.stderr?.on('data', (buf: Buffer) => {
    process.stderr.write(`[harness:vite] ${buf.toString('utf8')}`)
  })

  const devUrl = await waitForViteReady(child)
  const handoff = await waitForHandoff(handoffPath)

  process.env.PW_DEV_URL = devUrl
  process.env.PW_DAEMON_URL = `http://${handoff.host}:${handoff.port}`
  process.env.PW_DAEMON_WS_URL = `ws://${handoff.host}:${handoff.port}`
  process.env.PW_DAEMON_TOKEN = handoff.token
  process.env.PW_HARNESS_CHILD_PID = String(child.pid)
  process.env.PW_DAEMON_INSTANCE_ID = handoff.instanceId

  console.log(
    `[harness] ready — vite=${devUrl} daemon=${process.env.PW_DAEMON_URL} pid=${child.pid}`,
  )
}
