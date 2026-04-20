import fs from 'node:fs'

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
  debug?(msg: string, meta?: Record<string, unknown>): void
}

interface LoggerOptions {
  file: string
  maxBytes: number
}

// Keys whose values must always be replaced with [REDACTED].
// Matches: authorization, sec-websocket-protocol, *token, *Token, token*
const REDACT_KEYS = /^(authorization|sec-websocket-protocol|.*-?token|.*Token)$/i

// Subprotocol bearer strings — appear in WS Sec-WebSocket-Protocol header values.
// Any occurrence in a string value is replaced with [REDACTED_SUBPROTO].
const SUBPROTO_BEARER_RE = /base64url\.bearer\.authorization\.redesigner\.dev\.[A-Za-z0-9_-]+/g

/**
 * Recursively sanitises a value before it is serialised to the log file.
 *
 * - Object keys matching REDACT_KEYS → replaced with '[REDACTED]' (entire value, regardless of type).
 * - String values → subprotocol bearer substring replaced with '[REDACTED_SUBPROTO]'.
 * - Arrays → each element processed individually.
 * - Plain objects → each key/value processed recursively (with key-level redaction taking priority).
 * - Everything else (numbers, booleans, null) → passed through unchanged.
 */
export function redactValue(v: unknown): unknown {
  if (typeof v === 'string') return v.replace(SUBPROTO_BEARER_RE, '[REDACTED_SUBPROTO]')
  if (Array.isArray(v)) return v.map(redactValue)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.test(k) ? '[REDACTED]' : redactValue(val)
    }
    return out
  }
  return v
}

function redact(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined
  return redactValue(meta) as Record<string, unknown>
}

export function createLogger(opts: LoggerOptions): Logger {
  let fd = fs.openSync(opts.file, 'a')
  let rotationLock = false
  const queue: string[] = []

  function writeLine(level: string, msg: string, meta?: Record<string, unknown>): void {
    const safe = redact(meta)
    const line = `${JSON.stringify({ ts: Date.now(), level, msg, ...safe })}\n`
    if (rotationLock) {
      queue.push(line)
      return
    }
    const st = fs.fstatSync(fd)
    if (st.size + line.length > opts.maxBytes) {
      rotate(line)
      return
    }
    fs.writeSync(fd, line)
  }

  function rotate(pendingLine: string): void {
    rotationLock = true
    try {
      fs.closeSync(fd)
      try {
        fs.renameSync(opts.file, `${opts.file}.1`)
      } catch {
        // ignore rename errors (e.g. file already gone)
      }
      fd = fs.openSync(opts.file, 'a')
      fs.writeSync(fd, pendingLine)
      while (queue.length > 0) {
        const next = queue.shift()
        if (next !== undefined) fs.writeSync(fd, next)
      }
    } finally {
      rotationLock = false
    }
  }

  return {
    info: (m, meta) => writeLine('info', m, meta),
    warn: (m, meta) => writeLine('warn', m, meta),
    error: (m, meta) => writeLine('error', m, meta),
    debug: (m, meta) => writeLine('debug', m, meta),
  }
}
