import { expect, test } from 'vitest'
import { hostAllow } from '../src/hostAllow.js'

test('accepts literal authorities at the correct port', () => {
  const fn = hostAllow(5173)
  expect(fn('localhost:5173')).toBe(true)
  expect(fn('127.0.0.1:5173')).toBe(true)
  expect(fn('[::1]:5173')).toBe(true)
})

test('rejects port mismatch', () => {
  const fn = hostAllow(5173)
  expect(fn('localhost:5174')).toBe(false)
  expect(fn('127.0.0.1:80')).toBe(false)
})

test('rejects non-loopback / DNS-rebind variants', () => {
  const fn = hostAllow(5173)
  for (const h of [
    '0.0.0.0:5173',
    '[::]:5173',
    '[::ffff:127.0.0.1]:5173',
    'localhost.attacker.com:5173',
    '192.168.1.1:5173',
    'example.com:5173',
    'myhost.localhost:5173', // suffix trap, not a literal match
    'LOCALHOST:5173', // case-sensitive per HTTP: Host values vary; require exact.
  ]) {
    expect(fn(h)).toBe(false)
  }
})

test('rejects missing / non-string / empty host', () => {
  const fn = hostAllow(5173)
  expect(fn(undefined)).toBe(false)
  expect(fn('')).toBe(false)
})

test.each([
  'localhost:5173 ', // trailing whitespace
  ' localhost:5173', // leading whitespace
  'localhost:5173/', // trailing slash (not an authority)
  'localhost::5173', // duplicated colon
  '[0:0:0:0:0:0:0:1]:5173', // non-canonical IPv6 form of ::1
  '[::1]:5173 ', // trailing whitespace IPv6
])('rejects malformed / non-canonical Host: %s', (h) => {
  expect(hostAllow(5173)(h)).toBe(false)
})
