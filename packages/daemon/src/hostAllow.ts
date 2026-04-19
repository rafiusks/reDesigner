/**
 * Host-header literal-set allowlist per spec §3.2.
 *
 * Accepts exactly three authorities, each with the daemon's exact port:
 *   - `localhost:<port>`
 *   - `127.0.0.1:<port>`
 *   - `[::1]:<port>`
 *
 * Rejects: `0.0.0.0`, `[::]`, `[::ffff:127.0.0.1]`, raw non-loopback IPs,
 * `localhost.<anything>`, any port mismatch, DNS-rebind suffix traps.
 *
 * Returns a closed-over predicate so server.ts can inline-gate.
 */
export function hostAllow(port: number): (host: string | undefined) => boolean {
  const authorities = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`])
  return (host) => typeof host === 'string' && authorities.has(host)
}
