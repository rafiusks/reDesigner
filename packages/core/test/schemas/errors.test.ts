import { describe, expect, test } from 'vitest'
import { ApiErrorSchema, AuthErrorSchema, CorsErrorSchema } from '../../src/schemas/errors.js'

describe('AuthErrorSchema', () => {
  test('validates known reason', () => {
    expect(AuthErrorSchema.safeParse({ error: 'auth', reason: 'extid-mismatch' }).success).toBe(
      true,
    )
    expect(AuthErrorSchema.safeParse({ error: 'auth', reason: 'token-unknown' }).success).toBe(true)
    expect(AuthErrorSchema.safeParse({ error: 'auth', reason: 'token-tofu-fail' }).success).toBe(
      true,
    )
  })

  test('accepts unknown reason (forward-compat via .or(z.string()))', () => {
    const r = AuthErrorSchema.safeParse({ error: 'auth', reason: 'future-reason-code' })
    expect(r.success).toBe(true)
  })

  test('accepts unknown top-level field via catchall', () => {
    const r = AuthErrorSchema.safeParse({ error: 'auth', reason: 'extid-mismatch', trace: 'x' })
    expect(r.success).toBe(true)
  })
})

describe('CorsErrorSchema', () => {
  test('validates known reasons', () => {
    expect(CorsErrorSchema.safeParse({ error: 'cors', reason: 'malformed-origin' }).success).toBe(
      true,
    )
    expect(CorsErrorSchema.safeParse({ error: 'cors', reason: 'missing-origin' }).success).toBe(
      true,
    )
  })
})

describe('ApiErrorSchema (discriminated union)', () => {
  test('routes by error field', () => {
    const auth = ApiErrorSchema.safeParse({ error: 'auth', reason: 'token-unknown' })
    expect(auth.success).toBe(true)
    const cors = ApiErrorSchema.safeParse({ error: 'cors', reason: 'malformed-origin' })
    expect(cors.success).toBe(true)
  })

  test('rejects unknown error discriminant', () => {
    expect(ApiErrorSchema.safeParse({ error: 'other', reason: 'x' }).success).toBe(false)
  })
})
