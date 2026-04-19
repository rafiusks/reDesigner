/**
 * TOFU (Trust-On-First-Use) ext-ID pinning for the /exchange endpoint.
 *
 * On first successful exchange the daemon writes the chrome-extension
 * ID to `<runtimeRoot>/<projectHash>/trusted-ext-id`. Subsequent
 * exchanges from a different origin are rejected with
 * 403 + `apiErrorCode: 'unknown-extension'`.
 *
 * See packages/daemon/src/handoff.ts for the runtime-root layout and
 * ancestor-safety rationale; we reuse the same parent directory.
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * Reads the trusted ext-ID sidecar file. Returns `null` if it does not
 * exist, is not a regular file, or has unexpected mode bits (defensive).
 */
export function readTrustedExtId(trustedPath: string): string | null {
  let st: fs.Stats
  try {
    st = fs.lstatSync(trustedPath)
  } catch {
    return null
  }
  if (!st.isFile() || st.isSymbolicLink()) return null
  if (process.platform !== 'win32') {
    // Reject if group/other bits are set — treat as tampered.
    if ((st.mode & 0o077) !== 0) return null
  }
  try {
    const raw = fs.readFileSync(trustedPath, 'utf8').trim()
    if (raw.length === 0) return null
    return raw
  } catch {
    return null
  }
}

/**
 * Writes the trusted ext-ID sidecar file with mode 0o600. Creates the
 * parent directory with 0o700 if missing. Overwrites any existing file
 * atomically (write-to-temp + rename).
 *
 * Unlike writeHandoff, this is a plain overwrite — there is no EEXIST
 * reclaim semantics because pinning is deterministic: the caller has
 * already decided this ext-ID should be trusted.
 */
export function writeTrustedExtId(trustedPath: string, extId: string): void {
  const dir = path.dirname(trustedPath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

  // Write to a sibling temp file then rename for atomicity.
  const tmp = `${trustedPath}.tmp-${process.pid}-${Date.now()}`
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    const buf = Buffer.from(`${extId}\n`, 'utf8')
    let off = 0
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.renameSync(tmp, trustedPath)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {}
    throw err
  }
}

/**
 * Deletes the trusted ext-ID sidecar file. Used by the explicit
 * CLI override path / auto-reset window. Swallows ENOENT.
 */
export function clearTrustedExtId(trustedPath: string): void {
  try {
    fs.unlinkSync(trustedPath)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code !== 'ENOENT') throw err
  }
}
