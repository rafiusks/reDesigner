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

function redact(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (k === 'token') {
      out[k] = '[REDACTED]'
      continue
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redact(v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out
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
