import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

export const HandoffSchema = z
  .object({
    serverVersion: z.string().min(1),
    instanceId: z.string().uuid(),
    pid: z.number().int().positive(),
    host: z.literal('127.0.0.1'),
    port: z.number().int().min(1).max(65535),
    token: z.string().min(32).max(128),
    projectRoot: z.string().min(1),
    startedAt: z.number().int().nonnegative(),
  })
  .strict()

export type Handoff = z.infer<typeof HandoffSchema>

function getUid(): string {
  return process.platform === 'win32'
    ? (process.env.USERNAME ?? 'w')
    : String(process.getuid?.() ?? 'w')
}

function getRuntimeRoot(): { root: string; safeAncestor: string } {
  if (process.platform === 'linux') {
    if (process.env.XDG_RUNTIME_DIR) {
      return {
        root: path.join(process.env.XDG_RUNTIME_DIR, 'redesigner'),
        safeAncestor: process.env.XDG_RUNTIME_DIR,
      }
    }
    return { root: path.join(os.tmpdir(), `redesigner-${getUid()}`), safeAncestor: os.tmpdir() }
  }
  if (process.platform === 'darwin') {
    return { root: path.join(os.tmpdir(), `com.redesigner.${getUid()}`), safeAncestor: os.tmpdir() }
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    return { root: path.join(base, 'redesigner', getUid()), safeAncestor: base }
  }
  throw new Error(`unsupported platform: ${process.platform}`)
}

export function resolveHandoffPath(projectRoot: string): string {
  const real = fs.realpathSync(projectRoot)
  const projectHash = crypto.createHash('sha256').update(real).digest('hex').slice(0, 16)
  const { root } = getRuntimeRoot()
  return path.join(root, projectHash, 'daemon-v1.json')
}

/**
 * Returns the path to the TOFU trusted-ext-id sidecar file for a given project.
 * Lives in the same per-project runtime directory as the handoff file.
 */
export function resolveTrustedExtIdPath(projectRoot: string): string {
  const real = fs.realpathSync(projectRoot)
  const projectHash = crypto.createHash('sha256').update(real).digest('hex').slice(0, 16)
  const { root } = getRuntimeRoot()
  return path.join(root, projectHash, 'trusted-ext-id')
}

export function buildHandoff(opts: {
  serverVersion: string
  pid: number
  port: number
  token: string
  projectRoot: string
  instanceId?: string
}): Handoff {
  return {
    serverVersion: opts.serverVersion,
    instanceId: opts.instanceId ?? crypto.randomUUID(),
    pid: opts.pid,
    host: '127.0.0.1',
    port: opts.port,
    token: opts.token,
    projectRoot: opts.projectRoot,
    startedAt: Date.now(),
  }
}

function assertAncestorSafe(p: string, safeAncestor: string): void {
  let current = p
  while (current !== safeAncestor && current !== path.parse(current).root) {
    const st = fs.lstatSync(current)
    if (st.isSymbolicLink()) throw new Error(`handoff ancestor is symlink: ${current}`)
    if (process.platform !== 'win32') {
      if (st.uid !== process.getuid?.())
        throw new Error(`handoff ancestor uid mismatch: ${current}`)
      if ((st.mode & 0o022) !== 0)
        throw new Error(`handoff ancestor is group/other writable: ${current}`)
    }
    current = path.dirname(current)
  }
}

export function writeHandoff(handoffPath: string, handoff: Handoff): { fd: number } {
  const dir = path.dirname(handoffPath)
  const { safeAncestor } = getRuntimeRoot()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  assertAncestorSafe(dir, safeAncestor)
  if (process.platform !== 'win32') {
    const dirStat = fs.lstatSync(dir)
    if ((dirStat.mode & 0o077) !== 0) throw new Error(`handoff dir has group/other bits: ${dir}`)
  }

  let fd: number
  try {
    fd = fs.openSync(handoffPath, 'wx', 0o600)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code !== 'EEXIST') throw err
    const existingRaw = fs.readFileSync(handoffPath, 'utf8')
    let existing: Handoff
    try {
      existing = HandoffSchema.parse(JSON.parse(existingRaw))
    } catch {
      throw err
    }
    try {
      process.kill(existing.pid, 0)
      throw new Error('existing handoff alive; reclaim refused')
    } catch (probeErr) {
      const pe = probeErr as NodeJS.ErrnoException
      if (pe.code !== 'ESRCH') throw probeErr
      fs.unlinkSync(handoffPath)
      fd = fs.openSync(handoffPath, 'wx', 0o600)
    }
  }

  if (process.platform !== 'win32') {
    const fstat = fs.fstatSync(fd)
    const lstat = fs.lstatSync(handoffPath)
    if (fstat.ino !== lstat.ino || fstat.dev !== lstat.dev) {
      fs.closeSync(fd)
      throw new Error('fd ino/dev mismatch after open')
    }
    if ((fstat.mode & 0o177) !== 0) {
      fs.closeSync(fd)
      throw new Error('fd mode has unexpected bits')
    }
  }

  const buf = Buffer.from(JSON.stringify(handoff), 'utf8')
  try {
    let off = 0
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off)
  } catch (err) {
    fs.closeSync(fd)
    try {
      fs.unlinkSync(handoffPath)
    } catch {}
    throw err
  }
  return { fd }
}

export interface DiscoveryResult {
  path: string
  parsed: Handoff
  urlPrefix: string
  authHeader: string
}

export function discoverHandoff(projectRoot: string): DiscoveryResult | null {
  const p = resolveHandoffPath(projectRoot)
  let st: fs.Stats
  try {
    st = fs.lstatSync(p)
  } catch {
    return null
  }
  if (!st.isFile() || st.isSymbolicLink()) return null
  if (process.platform !== 'win32') {
    if (st.uid !== process.getuid?.()) return null
    if ((st.mode & 0o077) !== 0) return null
  }
  let parsed: Handoff
  try {
    parsed = HandoffSchema.parse(JSON.parse(fs.readFileSync(p, 'utf8')))
  } catch {
    return null
  }
  try {
    process.kill(parsed.pid, 0)
  } catch {
    return null
  }
  return {
    path: p,
    parsed,
    urlPrefix: `http://${parsed.host}:${parsed.port}`,
    authHeader: `Bearer ${parsed.token}`,
  }
}
