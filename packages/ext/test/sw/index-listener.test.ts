import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

describe('sw/index.ts onMessage listener shape', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../../src/sw/index.ts'), 'utf8')

  test('onMessage addListener callback is NOT async', () => {
    const asyncListener = /chrome\.runtime\.onMessage\.addListener\(\s*async/
    expect(source).not.toMatch(asyncListener)
  })

  test('onMessage addListener is followed within 30 lines by return true', () => {
    const startIdx = source.indexOf('chrome.runtime.onMessage.addListener(')
    expect(startIdx).toBeGreaterThanOrEqual(0)
    const window = source.slice(startIdx).split('\n').slice(0, 30).join('\n')
    expect(window).toMatch(/return\s+true/)
  })
})
