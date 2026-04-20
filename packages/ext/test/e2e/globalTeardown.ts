/**
 * Playwright global teardown — kills the vite+daemon harness spawned by
 * globalSetup.ts. The vite process owns the forked daemon (parent-death
 * propagation via child_process.fork), so SIGTERM to the vite PID is
 * enough. We send to the process group because the detached:true spawn
 * created a new pgid.
 *
 * Unconditionally no-ops when PW_HARNESS_CHILD_PID is unset (i.e. harness
 * wasn't started).
 */

export default async function globalTeardown(): Promise<void> {
  const pidStr = process.env.PW_HARNESS_CHILD_PID
  if (!pidStr) return
  const pid = Number(pidStr)
  if (!Number.isInteger(pid) || pid <= 0) return

  // Negative pid = process group. `detached: true` in globalSetup put vite
  // (and its forked daemon child) in a distinct group.
  try {
    process.kill(-pid, 'SIGTERM')
  } catch (err) {
    // ESRCH = already gone. Anything else is unexpected but non-fatal for teardown.
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      console.warn('[harness] teardown: failed to SIGTERM pgid', pid, err)
    }
  }

  // Give the daemon's shutdown-handoff a moment, then escalate if still alive.
  await new Promise<void>((r) => setTimeout(r, 1500))
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // If it's gone by now that's fine.
  }
}
