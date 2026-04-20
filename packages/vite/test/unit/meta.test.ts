/**
 * Tests for Task 14: transformIndexHtml meta injection + Vite CVE runtime pin.
 *
 * Coverage:
 *  1. Meta tag present in served HTML with name="redesigner-daemon"
 *  2. Content parses as JSON with all 6 HandshakeSchema fields
 *  3. bootstrapToken stable across calls (same session)
 *  4. pluginVersion equals PLUGIN_VERSION exported constant
 *  5. apply === 'serve' (build-mode guard implicit)
 *  6. CVE check: 5.4.18 → throws
 *  7. CVE check: 5.4.19 → ok
 *  8. CVE check: 6.2.6 → throws
 *  9. CVE check: 6.2.7 → ok
 * 10. CVE check: 5.3.0 → throws
 * 11. CVE check: 7.0.0 → ok
 * 12. CVE check: 6.2.7-beta.1 → ok (pre-release stripped)
 * 13. CVE check: 5.4.19-rc.3 → ok (pre-release stripped)
 * 14. Editor valid 'cursor' → no warn
 * 15. Editor invalid 'emacs' → console.warn + fallback
 * 16. Editor invalid number 42 → console.warn + fallback
 */

import type { Plugin, ResolvedConfig } from 'vite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkViteVersion, isViteVersionAllowed, parseSemver } from '../../src/viteVersionCheck'

const FAKE_HTML = '<html><head></head><body></body></html>'

function fakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    hasWarned: false,
    warnOnce: vi.fn(),
    clearScreen: vi.fn(),
    hasErrorLogged: () => false,
  }
}

function fakeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    root: '/tmp/redesigner-meta-test',
    logger: fakeLogger() as unknown as ResolvedConfig['logger'],
    plugins: [],
    esbuild: { jsx: 'automatic' },
    ...overrides,
  } as unknown as ResolvedConfig
}

function callConfigResolved(plugin: Plugin, cfg: ResolvedConfig): void {
  const fn =
    typeof plugin.configResolved === 'function'
      ? plugin.configResolved
      : plugin.configResolved?.handler
  ;(fn as (c: ResolvedConfig) => void).call({}, cfg)
}

function callTransformIndexHtml(plugin: Plugin, html: string, url = '/index.html'): string {
  const hook = plugin.transformIndexHtml
  if (!hook) return html
  const fn = typeof hook === 'function' ? hook : hook.handler
  const result = (fn as (html: string, ctx: { filename?: string }) => string | string)(html, {
    filename: url,
  })
  if (typeof result === 'string') return result
  return html
}

function freshDir(): string {
  return `/tmp/redesigner-meta-test-${Math.random().toString(36).slice(2)}`
}

describe('parseSemver', () => {
  it('parses plain semver', () => {
    expect(parseSemver('5.4.19')).toEqual([5, 4, 19])
    expect(parseSemver('6.2.7')).toEqual([6, 2, 7])
    expect(parseSemver('7.0.0')).toEqual([7, 0, 0])
  })

  it('strips pre-release suffix', () => {
    expect(parseSemver('6.2.7-beta.1')).toEqual([6, 2, 7])
    expect(parseSemver('5.4.19-rc.3')).toEqual([5, 4, 19])
    expect(parseSemver('6.2.7-alpha')).toEqual([6, 2, 7])
  })

  it('throws on empty string', () => {
    expect(() => parseSemver('')).toThrow(/could not parse Vite version/)
  })

  it('throws on non-numeric string "abc"', () => {
    expect(() => parseSemver('abc')).toThrow(/could not parse Vite version/)
  })

  it('throws on non-numeric string "x.y.z"', () => {
    expect(() => parseSemver('x.y.z')).toThrow(/could not parse Vite version/)
  })
})

describe('checkViteVersion', () => {
  it('5.4.18 throws CVE error', () => {
    expect(() => checkViteVersion('5.4.18')).toThrow(/CVE/)
  })

  it('5.4.19 ok', () => {
    expect(() => checkViteVersion('5.4.19')).not.toThrow()
  })

  it('6.2.6 throws CVE error', () => {
    expect(() => checkViteVersion('6.2.6')).toThrow(/CVE/)
  })

  it('6.2.7 ok', () => {
    expect(() => checkViteVersion('6.2.7')).not.toThrow()
  })

  it('5.3.0 throws (below both ranges)', () => {
    expect(() => checkViteVersion('5.3.0')).toThrow(/CVE/)
  })

  it('7.0.0 ok (major >= 7)', () => {
    expect(() => checkViteVersion('7.0.0')).not.toThrow()
  })

  it('6.2.7-beta.1 ok (pre-release stripped)', () => {
    expect(() => checkViteVersion('6.2.7-beta.1')).not.toThrow()
  })

  it('5.4.19-rc.3 ok (pre-release stripped)', () => {
    expect(() => checkViteVersion('5.4.19-rc.3')).not.toThrow()
  })

  it('5.4.18-rc.9 throws (5.4.18 < 5.4.19)', () => {
    expect(() => checkViteVersion('5.4.18-rc.9')).toThrow(/CVE/)
  })
})

describe('isViteVersionAllowed', () => {
  it('5.5.0 → true (minor > 4)', () => {
    expect(isViteVersionAllowed(5, 5, 0)).toBe(true)
  })

  it('5.4.19 → true', () => {
    expect(isViteVersionAllowed(5, 4, 19)).toBe(true)
  })

  it('5.4.18 → false', () => {
    expect(isViteVersionAllowed(5, 4, 18)).toBe(false)
  })

  it('5.3.99 → false (minor < 4)', () => {
    expect(isViteVersionAllowed(5, 3, 99)).toBe(false)
  })

  it('6.3.0 → true (minor > 2)', () => {
    expect(isViteVersionAllowed(6, 3, 0)).toBe(true)
  })

  it('6.2.7 → true', () => {
    expect(isViteVersionAllowed(6, 2, 7)).toBe(true)
  })

  it('6.2.6 → false', () => {
    expect(isViteVersionAllowed(6, 2, 6)).toBe(false)
  })

  it('4.99.99 → false (major < 5)', () => {
    expect(isViteVersionAllowed(4, 99, 99)).toBe(false)
  })

  it('7.0.0 → true', () => {
    expect(isViteVersionAllowed(7, 0, 0)).toBe(true)
  })

  it('0.0.0 → false', () => {
    expect(isViteVersionAllowed(0, 0, 0)).toBe(false)
  })
})

describe('redesigner plugin: serve-only guard', () => {
  it('apply is "serve"', async () => {
    const { default: redesigner } = await import('../../src/plugin')
    const p = redesigner() as Plugin
    expect(p.apply).toBe('serve')
  })

  it('transformIndexHtml hook exists', async () => {
    const { default: redesigner } = await import('../../src/plugin')
    const p = redesigner() as Plugin
    expect(p.transformIndexHtml).toBeDefined()
  })
})

describe('transformIndexHtml: meta tag injection', () => {
  it('injects meta tag into <head>', async () => {
    const { default: redesigner } = await import('../../src/plugin')
    const dir = freshDir()
    const p = redesigner({ editor: 'cursor' }) as Plugin
    callConfigResolved(p, fakeConfig({ root: dir }))
    const result = callTransformIndexHtml(p, FAKE_HTML)
    expect(result).toContain('name="redesigner-daemon"')
  })

  it('meta content is valid JSON with all 6 HandshakeSchema fields', async () => {
    const { default: redesigner } = await import('../../src/plugin')
    const dir = freshDir()
    const p = redesigner({ editor: 'cursor' }) as Plugin
    callConfigResolved(p, fakeConfig({ root: dir }))
    const result = callTransformIndexHtml(p, FAKE_HTML)

    const match = /name="redesigner-daemon"\s+content='([^']*)'/.exec(result)
    expect(match).not.toBeNull()
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const payload = JSON.parse(match![1]!) as Record<string, unknown>

    expect(payload).toHaveProperty('wsUrl')
    expect(payload).toHaveProperty('httpUrl')
    expect(payload).toHaveProperty('bootstrapToken')
    expect(payload).toHaveProperty('editor')
    expect(payload).toHaveProperty('pluginVersion')
    expect(payload).toHaveProperty('daemonVersion')
    expect(Object.keys(payload)).toHaveLength(6)
  })

  it('editor in meta matches configured editor', async () => {
    const { default: redesigner } = await import('../../src/plugin')
    const dir = freshDir()
    const p = redesigner({ editor: 'cursor' }) as Plugin
    callConfigResolved(p, fakeConfig({ root: dir }))
    const result = callTransformIndexHtml(p, FAKE_HTML)
    const match = /name="redesigner-daemon"\s+content='([^']*)'/.exec(result)
    expect(match).not.toBeNull()
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const payload = JSON.parse(match![1]!) as { editor: string }
    expect(payload.editor).toBe('cursor')
  })

  it('pluginVersion in meta equals PLUGIN_VERSION', async () => {
    const { default: redesigner, PLUGIN_VERSION } = await import('../../src/plugin')
    const dir = freshDir()
    const p = redesigner() as Plugin
    callConfigResolved(p, fakeConfig({ root: dir }))
    const result = callTransformIndexHtml(p, FAKE_HTML)
    const match = /name="redesigner-daemon"\s+content='([^']*)'/.exec(result)
    expect(match).not.toBeNull()
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const payload = JSON.parse(match![1]!) as { pluginVersion: string }
    expect(payload.pluginVersion).toBe(PLUGIN_VERSION)
  })

  it('bootstrapToken stable across multiple calls (same session)', async () => {
    const { default: redesigner } = await import('../../src/plugin')
    const dir = freshDir()
    const p = redesigner() as Plugin
    callConfigResolved(p, fakeConfig({ root: dir }))

    const extract = (html: string) => {
      const m = /name="redesigner-daemon"\s+content='([^']*)'/.exec(html)
      if (!m) throw new Error('meta tag not found')
      // biome-ignore lint/style/noNonNullAssertion: checked above
      return (JSON.parse(m[1]!) as { bootstrapToken: string }).bootstrapToken
    }
    const r1 = callTransformIndexHtml(p, FAKE_HTML)
    const r2 = callTransformIndexHtml(p, FAKE_HTML)
    expect(extract(r1)).toBe(extract(r2))
    expect(typeof extract(r1)).toBe('string')
    expect(extract(r1).length).toBeGreaterThan(0)
  })

  it('returns HTML unchanged when client not initialized (no configResolved)', async () => {
    const { default: redesigner } = await import('../../src/plugin')
    const p = redesigner() as Plugin
    // Do NOT call configResolved — client stays null
    const result = callTransformIndexHtml(p, FAKE_HTML)
    expect(result).toBe(FAKE_HTML)
  })

  it('HTML without <head> returns original and warns', async () => {
    const { default: redesigner } = await import('../../src/plugin')
    const dir = freshDir()
    const logger = fakeLogger()
    const p = redesigner() as Plugin
    callConfigResolved(
      p,
      fakeConfig({ root: dir, logger: logger as unknown as ResolvedConfig['logger'] }),
    )
    const htmlNoHead = '<html><body></body></html>'
    const result = callTransformIndexHtml(p, htmlNoHead)
    expect(result).toBe(htmlNoHead)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no <head> tag found'))
  })

  it('HTML with uppercase <HEAD> gets meta injected (case-insensitive)', async () => {
    const { default: redesigner } = await import('../../src/plugin')
    const dir = freshDir()
    const p = redesigner({ editor: 'cursor' }) as Plugin
    callConfigResolved(p, fakeConfig({ root: dir }))
    const htmlUpperHead = '<html><HEAD></HEAD><body></body></html>'
    const result = callTransformIndexHtml(p, htmlUpperHead)
    expect(result).toContain('name="redesigner-daemon"')
  })
})

describe('redesigner plugin: Vite CVE gate in configResolved', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  async function makePluginWithViteVersion(version: string): Promise<Plugin> {
    vi.doMock('vite/package.json', () => ({ default: { version }, version }))
    const { default: redesigner } = await import('../../src/plugin')
    return redesigner() as Plugin
  }

  it('Vite 5.4.18 configResolved throws CVE error', async () => {
    const p = await makePluginWithViteVersion('5.4.18')
    const dir = freshDir()
    expect(() => callConfigResolved(p, fakeConfig({ root: dir }))).toThrow(/CVE/)
  })

  it('Vite 5.4.19 configResolved ok', async () => {
    const p = await makePluginWithViteVersion('5.4.19')
    const dir = freshDir()
    expect(() => callConfigResolved(p, fakeConfig({ root: dir }))).not.toThrow()
  })

  it('Vite 6.2.6 configResolved throws CVE error', async () => {
    const p = await makePluginWithViteVersion('6.2.6')
    const dir = freshDir()
    expect(() => callConfigResolved(p, fakeConfig({ root: dir }))).toThrow(/CVE/)
  })

  it('Vite 6.2.7 configResolved ok', async () => {
    const p = await makePluginWithViteVersion('6.2.7')
    const dir = freshDir()
    expect(() => callConfigResolved(p, fakeConfig({ root: dir }))).not.toThrow()
  })

  it('Vite 5.3.0 configResolved throws (below both ranges)', async () => {
    const p = await makePluginWithViteVersion('5.3.0')
    const dir = freshDir()
    expect(() => callConfigResolved(p, fakeConfig({ root: dir }))).toThrow(/CVE/)
  })

  it('Vite 7.0.0 configResolved ok (major >= 7)', async () => {
    const p = await makePluginWithViteVersion('7.0.0')
    const dir = freshDir()
    expect(() => callConfigResolved(p, fakeConfig({ root: dir }))).not.toThrow()
  })

  it('Vite 6.2.7-beta.1 configResolved ok (pre-release stripped)', async () => {
    const p = await makePluginWithViteVersion('6.2.7-beta.1')
    const dir = freshDir()
    expect(() => callConfigResolved(p, fakeConfig({ root: dir }))).not.toThrow()
  })
})

describe('redesigner plugin: editor Zod validation', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('editor "cursor" no warn', async () => {
    const { default: redesigner } = await import('../../src/plugin')
    const dir = freshDir()
    const logger = fakeLogger()
    const p = redesigner({ editor: 'cursor' }) as Plugin
    callConfigResolved(
      p,
      fakeConfig({ root: dir, logger: logger as unknown as ResolvedConfig['logger'] }),
    )
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('editor "emacs" (invalid) warn + fallback to vscode', async () => {
    const { default: redesigner } = await import('../../src/plugin')
    const dir = freshDir()
    const logger = fakeLogger()
    const p = redesigner({ editor: 'emacs' as unknown as 'vscode' }) as Plugin
    callConfigResolved(
      p,
      fakeConfig({ root: dir, logger: logger as unknown as ResolvedConfig['logger'] }),
    )
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('emacs'))
  })

  it('editor 42 (invalid number) warn + fallback', async () => {
    const { default: redesigner } = await import('../../src/plugin')
    const dir = freshDir()
    const logger = fakeLogger()
    const p = redesigner({ editor: 42 as unknown as 'vscode' }) as Plugin
    callConfigResolved(
      p,
      fakeConfig({ root: dir, logger: logger as unknown as ResolvedConfig['logger'] }),
    )
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('42'))
  })
})
