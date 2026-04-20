/**
 * JSON.parse wrapper that strips __proto__, constructor, and prototype keys
 * via reviver. Combined with Zod's .strict() on downstream schemas, provides
 * belt-and-braces defense against prototype-pollution via malformed manifest
 * or selection files.
 */
export function safeJsonParse(raw: string): unknown {
  return JSON.parse(raw, (key, value) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return undefined
    }
    return value
  })
}
