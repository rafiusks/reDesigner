import { describe, expect, it } from 'vitest'
import { toPosixProjectRoot, toPosixRelative, rejectEscapingPath } from '../../src/core/pathGuards'

describe('toPosixProjectRoot', () => {
  it('normalizes Windows-native path with backslashes', () => {
    expect(toPosixProjectRoot('C:\\Users\\dev\\proj')).toBe('C:/Users/dev/proj')
  })
  it('passes posix unchanged', () => {
    expect(toPosixProjectRoot('/home/dev/proj')).toBe('/home/dev/proj')
  })
  it('throws on unnormalizable input', () => {
    expect(() => toPosixProjectRoot('')).toThrow(/empty/)
  })
})

describe('toPosixRelative', () => {
  it('produces posix relative path', () => {
    expect(toPosixRelative('C:/proj/src/x.tsx', 'C:/proj')).toBe('src/x.tsx')
  })
  it('produces posix relative on posix', () => {
    expect(toPosixRelative('/proj/src/x.tsx', '/proj')).toBe('src/x.tsx')
  })
})

describe('rejectEscapingPath', () => {
  it('rejects absolute path', () => {
    expect(() => rejectEscapingPath('/abs/path', '/proj')).toThrow(/absolute/)
  })
  it('rejects ../ escape', () => {
    expect(() => rejectEscapingPath('../elsewhere/x.json', '/proj')).toThrow(/escapes/)
  })
  it('accepts valid relative inside root', () => {
    expect(() => rejectEscapingPath('.redesigner/manifest.json', '/proj')).not.toThrow()
  })
})
