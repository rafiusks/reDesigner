/**
 * Vite CVE version gate.
 *
 * Allowed versions:
 *   (major === 5 && >= 5.4.19) || (major === 6 && >= 6.2.7) || major >= 7
 *
 * CVEs: CVE-2025-30208 / 31125 / 31486 / 32395 / 30231
 *
 * Pre-release suffixes (-beta.1, -rc.3, etc.) are stripped before comparison.
 * Decision: treat pre-release as equivalent to the stable release it precedes.
 * Rationale: the CVE patches are present in the release artifacts starting at
 * those version numbers; the pre-release build of the same version ships the
 * same fix.
 */

export function parseSemver(version: string): [number, number, number] {
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error(`[redesigner] could not parse Vite version: ${JSON.stringify(version)}`)
  }
  // Strip pre-release suffix (anything after the first '-')
  const clean = version.split('-')[0] ?? version
  const parts = clean.split('.')
  const major = Number.parseInt(parts[0] ?? '0', 10)
  const minor = Number.parseInt(parts[1] ?? '0', 10)
  const patch = Number.parseInt(parts[2] ?? '0', 10)
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
    throw new Error(`[redesigner] could not parse Vite version: ${JSON.stringify(version)}`)
  }
  return [major, minor, patch]
}

export function isViteVersionAllowed(major: number, minor: number, patch: number): boolean {
  if (major >= 7) return true
  if (major === 6) {
    if (minor > 2) return true
    if (minor === 2 && patch >= 7) return true
    return false
  }
  if (major === 5) {
    if (minor > 4) return true
    if (minor === 4 && patch >= 19) return true
    return false
  }
  return false
}

export function checkViteVersion(version: string): void {
  const [major, minor, patch] = parseSemver(version)
  if (!isViteVersionAllowed(major, minor, patch)) {
    throw new Error(
      `[redesigner] refusing to start on Vite ${version}. Minimum: 5.4.19 or 6.2.7 (CVE-2025-30208/31125/31486/32395/30231).`,
    )
  }
}
