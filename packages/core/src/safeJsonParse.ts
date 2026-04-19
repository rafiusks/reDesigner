/**
 * JSON.parse wrapper that strips __proto__, constructor, and prototype keys
 * via reviver. Combined with Zod's .strict() on downstream schemas, provides
 * belt-and-braces defense against prototype-pollution via malformed manifest
 * or selection files.
 */
export function safeJsonParse(raw: string): unknown {
  const parsed = JSON.parse(raw, (key, value) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return undefined
    }
    return value
  })

  // Clean the root object if it's an object by setting dangerous keys to undefined
  if (parsed !== null && typeof parsed === 'object') {
    Object.defineProperty(parsed, '__proto__', {
      value: undefined,
      writable: true,
      enumerable: false,
      configurable: true,
    })
    Object.defineProperty(parsed, 'constructor', {
      value: undefined,
      writable: true,
      enumerable: false,
      configurable: true,
    })
    Object.defineProperty(parsed, 'prototype', {
      value: undefined,
      writable: true,
      enumerable: false,
      configurable: true,
    })
  }

  return parsed
}
