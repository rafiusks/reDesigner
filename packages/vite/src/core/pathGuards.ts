import path from 'node:path'

export function toPosixProjectRoot(raw: string): string {
  if (!raw) throw new Error('[redesigner] projectRoot must be non-empty')
  return raw.replace(/\\/g, '/')
}

export function toPosixRelative(absFile: string, projectRoot: string): string {
  const rel = path.posix.relative(toPosixProjectRoot(projectRoot), toPosixProjectRoot(absFile))
  if (rel.includes('\\')) {
    throw new Error(`[redesigner] path normalization produced backslash (plugin bug): ${rel}`)
  }
  return rel
}

export function rejectEscapingPath(relOrAbs: string, projectRoot: string): void {
  if (path.isAbsolute(relOrAbs)) {
    throw new Error(`[redesigner] path must be relative to projectRoot, got absolute: ${relOrAbs}`)
  }
  // Use native path.resolve so Windows drive letters (D:\...) are recognized
  // as absolute; path.posix.resolve treats them as relative and prepends cwd,
  // breaking the prefix check.
  const resolvedNative = path.resolve(projectRoot, relOrAbs)
  const rootNative = path.resolve(projectRoot)
  const resolved = toPosixProjectRoot(resolvedNative)
  const rootPosix = toPosixProjectRoot(rootNative)
  if (!resolved.startsWith(`${rootPosix}/`) && resolved !== rootPosix) {
    throw new Error(`[redesigner] path escapes projectRoot: ${relOrAbs}`)
  }
}
