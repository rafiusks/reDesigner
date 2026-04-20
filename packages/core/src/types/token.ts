/**
 * Branded token types — compile-time tags that prevent accidentally mixing root,
 * bootstrap, and session tokens (or comparing one against another).
 *
 * At runtime these are just strings. The brand is erased. Use the helpers below
 * when crossing a trust boundary where the kind of token matters.
 */

declare const TokenKind: unique symbol

/** Phantom brand — never materializes at runtime. */
export type Token<K extends 'root' | 'bootstrap' | 'session'> = string & {
  readonly [TokenKind]: K
}

export type RootToken = Token<'root'>
export type BootstrapToken = Token<'bootstrap'>
export type SessionToken = Token<'session'>

/** Tag a raw string as a specific token kind. Runtime no-op; strictly typing sugar. */
export function asToken<K extends 'root' | 'bootstrap' | 'session'>(
  value: string,
  _kind: K,
): Token<K> {
  return value as Token<K>
}
