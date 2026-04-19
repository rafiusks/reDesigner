import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { FileTooLargeError, toMcpError } from '../../src/errors'

describe('toMcpError', () => {
  it('maps SyntaxError → InvalidRequest', () => {
    const err = toMcpError(new SyntaxError('boom'), 'reading x')
    expect(err).toBeInstanceOf(McpError)
    expect(err.code).toBe(ErrorCode.InvalidRequest)
    expect(err.message).toContain('malformed JSON')
  })

  it('maps ZodError → InvalidRequest with issue path', () => {
    const schema = z.object({ a: z.string() })
    const result = schema.safeParse({ a: 1 })
    if (result.success) throw new Error('expected failure')
    const err = toMcpError(result.error, 'reading x')
    expect(err.code).toBe(ErrorCode.InvalidRequest)
    expect(err.message).toContain('a')
  })

  it('maps ENOENT → InvalidRequest "file not found"', () => {
    const e = Object.assign(new Error('nope'), { code: 'ENOENT' })
    const err = toMcpError(e, 'reading x')
    expect(err.code).toBe(ErrorCode.InvalidRequest)
    expect(err.message).toContain('file not found')
  })

  it('maps EACCES → InvalidRequest "permission denied"', () => {
    const e = Object.assign(new Error('nope'), { code: 'EACCES' })
    const err = toMcpError(e, 'reading x')
    expect(err.message).toContain('permission denied')
  })

  it('maps FileTooLargeError → InvalidRequest with limit', () => {
    const err = toMcpError(new FileTooLargeError(1024, 4096), 'reading x')
    expect(err.message).toContain('1024')
  })

  it('falls back to InternalError for unknown errors', () => {
    const err = toMcpError(new Error('wtf'), 'reading x')
    expect(err.code).toBe(ErrorCode.InternalError)
  })
})
