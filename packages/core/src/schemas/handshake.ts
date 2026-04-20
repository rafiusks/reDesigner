import { z } from 'zod'

/**
 * Editor allowlist for deep-link URL builders.
 * Kept tight in v0 — extend via new enum member, never via free-form string.
 */
export const EditorSchema = z.enum(['cursor', 'vscode', 'webstorm', 'zed'])
export type Editor = z.infer<typeof EditorSchema>

/**
 * Handshake payload delivered via `/__redesigner/handshake.json` (body) +
 * `X-Redesigner-Bootstrap` response header (preferred; body retained for compat) +
 * `<meta>` tag injected by `transformIndexHtml`.
 */
export const HandshakeSchema = z
  .object({
    wsUrl: z.string().url(),
    httpUrl: z.string().url(),
    bootstrapToken: z.string().min(1),
    editor: EditorSchema,
    pluginVersion: z.string().min(1),
    daemonVersion: z.string().min(1).nullable(),
  })
  .strict()
export type Handshake = z.infer<typeof HandshakeSchema>

/**
 * `POST /__redesigner/exchange` request body.
 * `clientNonce` is a base64url fresh-random blob; one-shot per bootstrap.
 */
export const ExchangeRequestSchema = z
  .object({
    clientNonce: z.string().min(16),
    bootstrapToken: z.string().min(1),
  })
  .strict()
export type ExchangeRequest = z.infer<typeof ExchangeRequestSchema>

/**
 * `POST /__redesigner/exchange` response body.
 * `exp` is the absolute Unix-ms expiry of `sessionToken`; TTL ≤ 300 s.
 * `serverNonce` is fresh per mint and must be echoed back in `hello.serverNonceEcho`.
 */
export const ExchangeResponseSchema = z
  .object({
    sessionToken: z.string().min(1),
    exp: z.number().int().positive(),
    serverNonce: z.string().min(16),
  })
  .strict()
export type ExchangeResponse = z.infer<typeof ExchangeResponseSchema>
