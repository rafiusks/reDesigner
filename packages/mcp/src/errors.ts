import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import type { ZodError } from 'zod'

export class FileTooLargeError extends Error {
  constructor(
    public readonly limitBytes: number,
    public readonly actualBytes: number,
  ) {
    super(`file exceeds ${limitBytes}-byte limit (actual ${actualBytes})`)
    this.name = 'FileTooLargeError'
  }
}

function isZodError(err: unknown): err is ZodError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'issues' in err &&
    Array.isArray((err as { issues: unknown }).issues)
  )
}

/**
 * context should be a short RELATIVE-path identifier, never an absolute path.
 * Enforced by discipline + code review; not asserted at runtime.
 */
export function toMcpError(err: unknown, context: string): McpError {
  if (err instanceof SyntaxError) {
    return new McpError(ErrorCode.InvalidRequest, `${context}: malformed JSON — ${err.message}`)
  }
  if (isZodError(err)) {
    const first = err.issues[0]
    const path = first?.path.join('.') || '(root)'
    return new McpError(
      ErrorCode.InvalidRequest,
      `${context}: ${path} — ${first?.message ?? 'validation failed'}`,
    )
  }
  if (err instanceof FileTooLargeError) {
    return new McpError(
      ErrorCode.InvalidRequest,
      `${context}: file exceeds size limit (${err.limitBytes} bytes)`,
    )
  }
  const nodeErr = err as NodeJS.ErrnoException
  if (nodeErr?.code === 'ENOENT') {
    return new McpError(ErrorCode.InvalidRequest, `${context}: file not found`)
  }
  if (nodeErr?.code === 'EACCES' || nodeErr?.code === 'EPERM') {
    return new McpError(ErrorCode.InvalidRequest, `${context}: permission denied`)
  }
  return new McpError(ErrorCode.InternalError, `${context}: ${String(err)}`)
}
