/**
 * Error taxonomy.
 *
 * - `RpcErrorCode`: JSON-RPC numeric codes (server-error range -32000..-32099 + standards).
 * - `ApiErrorCode`: REST slug the daemon emits in problem+json `apiErrorCode` extension.
 * - Crosswalks are total over every ApiErrorCode value.
 */
export enum RpcErrorCode {
  ExtensionDisconnected = -32001,
  ExtensionTimeout = -32002,
  ExtensionNoActivePick = -32003,
  ElementNotFound = -32004,
  ResultTooLarge = -32005,
  Shutdown = -32006,
  InstanceChanged = -32007,
  RateLimitExceeded = -32008,
  VersionNotAcceptable = -32009,
  // JSON-RPC 2.0 standard codes
  InvalidParams = -32602,
  InternalError = -32603,
  // NOTE: InvalidRequest (-32600) used by the transport layer on batch rejection; not mapped to an ApiErrorCode.
}

export type ApiErrorCode =
  | 'extension-disconnected'
  | 'extension-timeout'
  | 'extension-no-active-pick'
  | 'element-not-found'
  | 'result-too-large'
  | 'shutdown'
  | 'instance-changed'
  | 'rate-limit-exceeded'
  | 'version-not-acceptable'
  | 'invalid-params'
  | 'internal-error'
  | 'host-rejected'
  | 'method-not-allowed'
  | 'not-found'
  | 'unknown-extension'
  | 'stale-selection'
  | 'endpoint-moved'
  | 'session-revalidate-exhausted'

export const ApiErrorCodeToRpc: Record<ApiErrorCode, RpcErrorCode | null> = {
  'extension-disconnected': RpcErrorCode.ExtensionDisconnected,
  'extension-timeout': RpcErrorCode.ExtensionTimeout,
  'extension-no-active-pick': RpcErrorCode.ExtensionNoActivePick,
  'element-not-found': RpcErrorCode.ElementNotFound,
  'result-too-large': RpcErrorCode.ResultTooLarge,
  shutdown: RpcErrorCode.Shutdown,
  'instance-changed': RpcErrorCode.InstanceChanged,
  'rate-limit-exceeded': RpcErrorCode.RateLimitExceeded,
  'version-not-acceptable': RpcErrorCode.VersionNotAcceptable,
  'invalid-params': RpcErrorCode.InvalidParams,
  'internal-error': RpcErrorCode.InternalError,
  // REST-only (no JSON-RPC counterpart; they describe transport/resource issues)
  'host-rejected': null,
  'method-not-allowed': null,
  'not-found': null,
  'unknown-extension': null,
  'stale-selection': null,
  'endpoint-moved': null,
  'session-revalidate-exhausted': null,
}

export const ApiErrorCodeToHttpStatus: Record<ApiErrorCode, number> = {
  'extension-disconnected': 503,
  'extension-timeout': 504,
  'extension-no-active-pick': 409,
  'element-not-found': 404,
  'result-too-large': 413,
  shutdown: 503,
  'instance-changed': 409,
  'rate-limit-exceeded': 429,
  'version-not-acceptable': 406,
  'invalid-params': 400,
  'internal-error': 500,
  'host-rejected': 421,
  'method-not-allowed': 405,
  'not-found': 404,
  'unknown-extension': 403,
  'stale-selection': 409,
  'endpoint-moved': 410,
  'session-revalidate-exhausted': 401,
}

/** Reverse lookup: RPC → slug (partial; RPC codes without a slug have no entry). */
export const ErrorCrosswalk: Partial<Record<RpcErrorCode, ApiErrorCode>> = Object.fromEntries(
  Object.entries(ApiErrorCodeToRpc)
    .filter(([, rpc]) => rpc !== null)
    .map(([api, rpc]) => [rpc, api]),
) as Partial<Record<RpcErrorCode, ApiErrorCode>>
