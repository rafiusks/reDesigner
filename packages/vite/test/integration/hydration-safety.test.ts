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

// Richer App than E-8's minimal fixture: two nested components, a Fragment, ~5 host
// elements. A regression where the plugin accidentally tags SSR output would produce
// multiple data-redesigner-loc attributes — hard to miss.
const APP_SSR_SOURCE = `
import { Fragment } from 'react'

function Header() {
  return (
    <Fragment>
      <h1>Heading</h1>
      <p>Subtitle</p>
    </Fragment>
  )
}

function Body() {
  return (
    <section>
      <span>Content</span>
    </section>
  )
}

export default function App() {
  return (
    <div>
      <Header />
      <Body />
    </div>
  )
}
`

// Separate source file for the client-transform positive-control check.
// Using a distinct file avoids Vite's module-cache returning a stale result
// when the same module ID is transformed twice with different SSR flags.
const APP_CLIENT_SOURCE = `
function Card() {
  return (
    <article>
      <h2>Card</h2>
      <p>Body text</p>
    </article>
  )
}

export default function AppClient() {
  return (
    <div>
      <Card />
      <span>Footer</span>
    </div>
  )
}
`

describe('vite integration: hydration-safety — client-only premise lockdown', () => {
  let dir: string
  let server: ViteDevServer

  beforeAll(async () => {
    // realpathSync required on macOS: /var/folders → /private/var/folders symlink mismatch
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'redesigner-hydration-safety-')))
    mkdirSync(path.join(dir, 'src'), { recursive: true })

    writeFileSync(path.join(dir, 'src/App.tsx'), APP_SSR_SOURCE)
    writeFileSync(path.join(dir, 'src/AppClient.tsx'), APP_CLIENT_SOURCE)

    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'vite-hydration-safety-test',
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

  // Scenario 1: renderToString end-to-end must produce zero data-redesigner-loc attributes.
  //
  // The reDesigner Vite plugin is intentionally client-only for v0. ssrLoadModule loads
  // modules through the SSR environment where the plugin's transform skips attribute
  // injection. The rendered HTML must therefore contain no data-redesigner-loc strings.
  //
  // If this test fails, you are shipping SSR support. That was intentionally out-of-scope
  // for v0 — update this test deliberately (see §9 'HMR granularity beyond file-level —
  // out of scope' and §10 decision #7 'Dev-only').
  it('renderToString of a multi-component App produces zero data-redesigner-loc attributes', async () => {
    const mod = await server.ssrLoadModule('/src/App.tsx')
    // ssrLoadModule returns Record<string, unknown> — narrow to a callable component.
    const AppComponent = mod.default as Parameters<typeof createElement>[0]
    expect(AppComponent).toBeDefined()

    const html = renderToString(createElement(AppComponent))
    expect(html).not.toContain('data-redesigner-loc')
  }, 15000)

  // Scenario 2: positive-control — the client transform of the SAME app WOULD inject attributes.
  // Guards against a false-negative from a broken test setup where the plugin always skips.
  it('client transformRequest of the same source DOES contain data-redesigner-loc attributes', async () => {
    const result = await server.transformRequest('/src/AppClient.tsx')
    expect(result).not.toBeNull()
    if (!result) return

    expect(result.code).toContain('data-redesigner-loc')
  }, 15000)
})
