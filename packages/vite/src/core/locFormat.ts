export interface ParsedLoc {
  filePath: string
  line: number
  col: number
}

const DRIVE_LETTER = /^[A-Za-z]:/

export function formatLoc(filePath: string, line: number, col: number): string {
  if (filePath.includes('\\')) {
    throw new Error(`[redesigner] filePath must use posix separators, got: ${filePath}`)
  }
  if (DRIVE_LETTER.test(filePath)) {
    throw new Error(`[redesigner] filePath must not have drive letter prefix, got: ${filePath}`)
  }
  return `${filePath}:${line}:${col}`
}

export function parseLoc(s: string): ParsedLoc {
  // Parse from the RIGHT — filePath may contain colons in exotic FS; last two `:` segments are line:col.
  const lastColon = s.lastIndexOf(':')
  const secondLastColon = s.lastIndexOf(':', lastColon - 1)
  if (lastColon < 0 || secondLastColon < 0) {
    throw new Error(`[redesigner] malformed loc: ${s}`)
  }
  const filePath = s.slice(0, secondLastColon)
  const line = Number(s.slice(secondLastColon + 1, lastColon))
  const col = Number(s.slice(lastColon + 1))
  if (!Number.isFinite(line) || !Number.isFinite(col)) {
    throw new Error(`[redesigner] malformed loc (non-numeric line/col): ${s}`)
  }
  return { filePath, line, col }
}
