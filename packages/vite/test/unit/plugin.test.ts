import type { Plugin, ResolvedConfig } from 'vite'
import { describe, expect, it, vi } from 'vitest'
import redesigner from '../../src/plugin'

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
    root: '/tmp/redesigner-plugin-test',
    logger: fakeLogger() as unknown as ResolvedConfig['logger'],
    plugins: [],
    esbuild: { jsx: 'automatic' },
    ...overrides,
  } as unknown as ResolvedConfig
}

describe('redesigner plugin', () => {
  it('default options merge: include/exclude defaults apply', () => {
    const p = redesigner() as Plugin
    expect(p.name).toBe('redesigner')
    expect(p.enforce).toBe('pre')
    expect(p.apply).toBe('serve')
  })

  it('configResolved throws on classic JSX runtime detected authoritatively', () => {
    const p = redesigner() as Plugin
    const config = fakeConfig({ esbuild: { jsx: 'transform' } as ResolvedConfig['esbuild'] })
    const fn = typeof p.configResolved === 'function' ? p.configResolved : p.configResolved?.handler
    expect(fn).toBeDefined()
    expect(() => (fn as (c: ResolvedConfig) => void).call({}, config)).toThrow(
      /classic JSX runtime/,
    )
  })

  it('classic-only-tsconfig: info log, proceeds', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const pathMod = await import('node:path')
    const dir = mkdtempSync(pathMod.join(tmpdir(), 'redesigner-plugin-'))
    writeFileSync(
      pathMod.join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { jsx: 'react' } }),
    )

    const logger = fakeLogger()
    const p = redesigner() as Plugin
    const config = fakeConfig({
      root: dir,
      logger: logger as unknown as ResolvedConfig['logger'],
      esbuild: undefined as unknown as ResolvedConfig['esbuild'],
      plugins: [],
    })
    const fn = typeof p.configResolved === 'function' ? p.configResolved : p.configResolved?.handler
    ;(fn as (c: ResolvedConfig) => void).call({}, config)
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('tsconfig hints at classic JSX runtime'),
    )
    rmSync(dir, { recursive: true, force: true })
  })

  it('enabled=false: configResolved info logs and does not initialize writer', () => {
    const logger = fakeLogger()
    const p = redesigner({ enabled: false }) as Plugin
    const config = fakeConfig({ logger: logger as unknown as ResolvedConfig['logger'] })
    const fn = typeof p.configResolved === 'function' ? p.configResolved : p.configResolved?.handler
    ;(fn as (c: ResolvedConfig) => void).call({}, config)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('disabled'))
  })

  it('transform skips non-JSX files', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const pathMod = await import('node:path')
    const dir = mkdtempSync(pathMod.join(tmpdir(), 'redesigner-plugin-'))

    const logger = fakeLogger()
    const p = redesigner() as Plugin
    const config = fakeConfig({ root: dir, logger: logger as unknown as ResolvedConfig['logger'] })
    const configResolved =
      typeof p.configResolved === 'function' ? p.configResolved : p.configResolved?.handler
    ;(configResolved as (c: ResolvedConfig) => void).call({}, config)

    const transform = typeof p.transform === 'function' ? p.transform : p.transform?.handler
    const ctx = { environment: { name: 'client' } }
    const result = await (
      transform as (this: typeof ctx, code: string, id: string, opts: object) => Promise<undefined>
    ).call(ctx, 'export const x = 1', '/tmp/x.ts', {})
    expect(result).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it('transform skips SSR environment', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const pathMod = await import('node:path')
    const dir = mkdtempSync(pathMod.join(tmpdir(), 'redesigner-plugin-'))

    const p = redesigner() as Plugin
    const config = fakeConfig({ root: dir })
    const configResolved =
      typeof p.configResolved === 'function' ? p.configResolved : p.configResolved?.handler
    ;(configResolved as (c: ResolvedConfig) => void).call({}, config)

    const transform = typeof p.transform === 'function' ? p.transform : p.transform?.handler
    const ctx = { environment: { name: 'ssr' } }
    const result = await (
      transform as (this: typeof ctx, code: string, id: string, opts: object) => Promise<undefined>
    ).call(ctx, 'export const x = 1', '/tmp/x.tsx', {})
    expect(result).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })
})
