import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createLogger } from '../../src/logger.js'

describe('logger', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-'))
  })

  it('redacts token key in meta', () => {
    const logger = createLogger({ file: path.join(dir, 'd.log'), maxBytes: 1_000_000 })
    logger.info('startup', { token: 'secret-abcdefghij', pid: 42 })
    const line = fs.readFileSync(path.join(dir, 'd.log'), 'utf8')
    expect(line).not.toContain('secret-abcdefghij')
    expect(line).toContain('[REDACTED]')
    expect(line).toContain('"pid":42')
  })

  it('redacts 4-char prefix of token', () => {
    const logger = createLogger({ file: path.join(dir, 'd.log'), maxBytes: 1_000_000 })
    logger.info('debug', { token: 'abcd1234efgh5678' })
    const line = fs.readFileSync(path.join(dir, 'd.log'), 'utf8')
    expect(line).not.toContain('abcd')
  })

  it('rotates when file exceeds maxBytes', () => {
    const logger = createLogger({ file: path.join(dir, 'd.log'), maxBytes: 500 })
    for (let i = 0; i < 20; i++) logger.info('x'.repeat(100))
    expect(fs.existsSync(path.join(dir, 'd.log.1'))).toBe(true)
  })
})
