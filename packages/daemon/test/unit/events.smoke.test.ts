import { describe, expect, it } from 'vitest'
import { parseSince, shouldRejectOrigin } from '../../src/ws/events.js'

describe('events upgrade helpers', () => {
  it('rejects literal null Origin', () => {
    expect(shouldRejectOrigin('null')).toBe(true)
  })
  it('accepts absent Origin', () => {
    expect(shouldRejectOrigin(undefined)).toBe(false)
  })
  it('accepts chrome-extension:// prefix', () => {
    expect(shouldRejectOrigin('chrome-extension://abc')).toBe(false)
  })
  it('accepts moz-extension:// prefix', () => {
    expect(shouldRejectOrigin('moz-extension://abc')).toBe(false)
  })
  it('accepts vscode-webview:// prefix', () => {
    expect(shouldRejectOrigin('vscode-webview://abc')).toBe(false)
  })
  it('rejects random https origin', () => {
    expect(shouldRejectOrigin('https://evil.com')).toBe(true)
  })
  it('parseSince 0 and large valid', () => {
    expect(parseSince('0')).toBe(0)
    expect(parseSince('12345')).toBe(12345)
  })
  it('parseSince rejects leading zeros + letters + negative', () => {
    expect(parseSince('01')).toBe(null)
    expect(parseSince('12a')).toBe(null)
    expect(parseSince('-5')).toBe(null)
  })
  it('parseSince rejects null/undefined/empty', () => {
    expect(parseSince(null)).toBe(null)
    expect(parseSince(undefined)).toBe(null)
    expect(parseSince('')).toBe(null)
  })
  it('parseSince rejects 17+ digit numbers', () => {
    expect(parseSince('1'.repeat(17))).toBe(null)
    expect(parseSince('1'.repeat(16))).not.toBe(null)
  })
})
