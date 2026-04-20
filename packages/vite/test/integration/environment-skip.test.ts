import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { type ESBuildOptions, type ViteDevServer, createServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import redesigner from '../../src/index'

const PKG_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..')

// Two source files so scenario 1 can assert both skip (SSR) and attribute (client)
// without a query-string cache-buster (which the plugin's tsx regex would reject).
const APP_SSR_SOURCE = `export default function AppSsr() {
  return <div><span>ssr-check</span></div>
}
`

const APP_CLIENT_SOURCE = `export default function AppClient() {
  return <div><span>client-check</span></div>
}
`

describe('vite integration: SSR environment skip', () => {
  let dir: string
  let server: ViteDevServer
  let hasEnvironmentsApi = false

  beforeAll(async () => {
    // realpathSync required on macOS: /var/folders → /private/var/folders symlink mismatch
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'redesigner-env-skip-')))
    mkdirSync(path.join(dir, 'src'), { recursive: true })

    writeFileSync(path.join(dir, 'src/AppSsr.tsx'), APP_SSR_SOURCE)
    writeFileSync(path.join(dir, 'src/AppClient.tsx'), APP_CLIENT_SOURCE)

    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'vite-env-skip-test',
        type: 'module',
        version: '0.0.0',
        private: true,
      }),
    )

    // Symlink packages/vite/node_modules into the tmpdir so Vite can resolve React
    // via normal Node externalization for ssrLoadModule (avoids CJS-in-ESM evaluator issue
    // that occurs when resolve.alias points directly at CJS files for SSR transforms).
    // 'junction' is required on Windows to avoid EPERM without SeCreateSymbolicLink privilege;
    // POSIX ignores the third argument.
    symlinkSync(path.join(PKG_ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'junction')

    server = await createServer({
      root: dir,
      configFile: false,
      plugins: [redesigner()],
      esbuild: { jsx: 'automatic' } as ESBuildOptions,
      server: { port: 0, strictPort: false, middlewareMode: true, fs: { strict: false } },
      clearScreen: false,
    })
    hasEnvironmentsApi = Boolean(server.environments?.ssr)
  }, 15000)

  afterAll(async () => {
    // ssrLoadModule spins up the SSR module runner which keeps a file watcher alive;
    // server.close() can hang >10s on macOS waiting for it. Race the close against a
    // 2s ceiling and continue regardless — vitest's worker will reap the rest on exit.
    await Promise.race([server?.close(), new Promise<void>((r) => setTimeout(r, 2000))])
    if (dir) {
      try {
        unlinkSync(path.join(dir, 'node_modules'))
      } catch {}
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10000)

  // Scenario 1: Vite 5 legacy { ssr: true } flag path.
  // plugin.ts line 127: `if ((transformOpts as { ssr?: boolean } | undefined)?.ssr === true) return undefined`
  // A transform called with { ssr: true } must produce no data-redesigner-loc attributes.
  // We use two distinct source files to avoid the module-cache issue: AppSsr.tsx is
  // transformed with ssr:true, AppClient.tsx without — both are fresh module IDs.
  it('ssr-flag transform produces no data-redesigner-loc attributes', async () => {
    const ssrResult = await server.transformRequest('/src/AppSsr.tsx', { ssr: true })
    expect(ssrResult).not.toBeNull()
    if (!ssrResult) return

    expect(ssrResult.code).not.toContain('data-redesigner-loc')

    // Confirm the plugin WOULD inject the attribute on a normal client transform,
    // so the test would catch a regression where the plugin always skips.
    const clientResult = await server.transformRequest('/src/AppClient.tsx')
    expect(clientResult).not.toBeNull()
    if (!clientResult) return

    expect(clientResult.code).toContain('data-redesigner-loc')
  }, 15000)

  // Scenario 2: Vite 6+ environment-name path. Skipped on Vite 5 where environments API is absent.
  // plugin.ts line 126: `if (this.environment && this.environment.name !== 'client') return undefined`
  // Transforms run through server.environments.ssr have environment.name === 'ssr', so the
  // plugin returns undefined and no data-redesigner-loc is injected.
  it('ssr environment transformRequest produces no data-redesigner-loc attributes', async (ctx) => {
    if (!hasEnvironmentsApi) {
      ctx.skip()
      return
    }
    const ssrEnv = server.environments.ssr
    // biome-ignore lint/style/noNonNullAssertion: hasEnvironmentsApi guard ensures presence
    const result = await ssrEnv!.transformRequest('/src/AppSsr.tsx')
    expect(result).not.toBeNull()
    if (!result) return

    expect(result.code).not.toContain('data-redesigner-loc')
  }, 15000)

  // Scenario 3: renderToString end-to-end.
  // ssrLoadModule loads the module through the SSR environment (no data-redesigner-loc injected).
  // The rendered HTML must therefore contain zero data-redesigner-loc attribute strings.
  it('renderToString output contains no data-redesigner-loc attributes', async () => {
    const mod = await server.ssrLoadModule('/src/AppSsr.tsx')
    // ssrLoadModule returns Record<string, unknown> — narrow to a callable component.
    const AppComponent = mod.default as Parameters<typeof createElement>[0]
    expect(AppComponent).toBeDefined()

    const html = renderToString(createElement(AppComponent))
    expect(html).not.toContain('data-redesigner-loc')
  }, 15000)
})
