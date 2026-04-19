import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ESBuildOptions, type ViteDevServer, createServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Manifest } from '../../src/core/types-public'
import redesigner from '../../src/index'
import { readManifest } from '../../src/reader'

// Resolve to the packages/vite node_modules for React aliases.
// The tmpdir project has no react installed; we point Vite's resolver at our own.
const PKG_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..')
const REACT_DIR = path.join(PKG_ROOT, 'node_modules/react')
const REACT_DOM_DIR = path.join(PKG_ROOT, 'node_modules/react-dom')

/**
 * After esbuild compiles JSX, `data-redesigner-loc` attributes become props in
 * jsxDEV() calls: jsxDEV("div", { "data-redesigner-loc": "src/App.tsx:1:0", ... })
 * This regex extracts those string prop values from the compiled JS output.
 */
function extractLocAttrs(code: string): string[] {
  const matches = [...code.matchAll(/"data-redesigner-loc":\s*"([^"]+)"/g)]
  return matches.map((m) => m[1] ?? '')
}

describe('vite integration: DOM tagging + manifest round-trip', () => {
  let dir: string
  let server: ViteDevServer

  beforeAll(async () => {
    // realpathSync required on macOS: /var/folders → /private/var/folders symlink mismatch
    // between mkdtempSync return value and Vite-resolved id would corrupt relPath.
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'redesigner-vite-')))
    mkdirSync(path.join(dir, 'src'), { recursive: true })

    writeFileSync(
      path.join(dir, 'src/App.tsx'),
      `export function Inner() {
  return <div><span>inner</span></div>
}

export default function App() {
  return (
    <section>
      <h1>header</h1>
      <Inner />
    </section>
  )
}
`,
    )
    writeFileSync(
      path.join(dir, 'src/main.tsx'),
      `import { createRoot } from 'react-dom/client'
import App from './App'

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
`,
    )
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'vite-int-test',
        type: 'module',
        version: '0.0.0',
        private: true,
      }),
    )

    server = await createServer({
      root: dir,
      configFile: false,
      plugins: [redesigner()],
      // esbuild: jsx:automatic required to compile JSX → jsxDEV calls after Babel injects attrs.
      esbuild: { jsx: 'automatic' } as ESBuildOptions,
      // fs.strict: false required — tmpdir may live outside Vite's default allow-list on macOS
      server: { port: 0, strictPort: false, middlewareMode: true, fs: { strict: false } },
      // The tmpdir project has no React installed. Point Vite's resolver at our own.
      resolve: {
        alias: {
          'react/jsx-dev-runtime': path.join(REACT_DIR, 'jsx-dev-runtime.js'),
          'react/jsx-runtime': path.join(REACT_DIR, 'jsx-runtime.js'),
          'react-dom/client': path.join(REACT_DOM_DIR, 'client.js'),
          'react-dom': path.join(REACT_DOM_DIR, 'index.js'),
          react: path.join(REACT_DIR, 'index.js'),
        },
      },
      clearScreen: false,
    })
  }, 15000)

  afterAll(async () => {
    await server?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('transforms App.tsx: non-wrapper host elements get data-redesigner-loc', async () => {
    const result = await server.transformRequest('/src/App.tsx')
    expect(result).not.toBeNull()
    if (!result) return

    const locAttrs = extractLocAttrs(result.code)

    // 5 host elements (div, span, section, h1, Inner); Inner is user-authored so it IS tagged.
    expect(locAttrs.length).toBeGreaterThanOrEqual(4)
    for (const loc of locAttrs) {
      expect(loc).toMatch(/^.+\.tsx:\d+:\d+$/)
    }
  }, 15000)

  it('main.tsx module-scope JSX is NOT tagged (attribute omitted)', async () => {
    const result = await server.transformRequest('/src/main.tsx')
    expect(result).not.toBeNull()
    if (!result) return

    const locAttrs = extractLocAttrs(result.code)
    expect(locAttrs.length).toBe(0)
  }, 15000)

  it('manifest: after transforms, manifest.json exists with expected entries', async () => {
    await server.transformRequest('/src/App.tsx')
    await server.transformRequest('/src/main.tsx')

    const manifestPath = path.join(dir, '.redesigner/manifest.json')
    const deadline = Date.now() + 10000
    while (!existsSync(manifestPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(existsSync(manifestPath)).toBe(true)

    let manifest: Manifest | undefined
    while (Date.now() < deadline) {
      manifest = await readManifest(manifestPath)
      const hasApp = Object.keys(manifest.components).some((k) => k.includes('App.tsx'))
      const hasMain = Object.keys(manifest.components).some((k) => k.includes('main.tsx'))
      if (hasApp && hasMain) break
      await new Promise((r) => setTimeout(r, 100))
    }

    expect(manifest).toBeDefined()
    if (!manifest) return
    expect(manifest.schemaVersion).toBe('1.0')
    const appComponents = Object.keys(manifest.components).filter((k) => k.includes('App.tsx'))
    expect(appComponents.length).toBeGreaterThanOrEqual(2)
    const moduleComp = Object.keys(manifest.components).find((k) =>
      k.includes('main.tsx::(module)'),
    )
    expect(moduleComp).toBeDefined()
  }, 15000)

  it('locs: every data-redesigner-loc value in App.tsx maps to a manifest loc entry', async () => {
    const result = await server.transformRequest('/src/App.tsx')
    expect(result).not.toBeNull()
    if (!result) return
    const locAttrs = extractLocAttrs(result.code)
    expect(locAttrs.length).toBeGreaterThanOrEqual(1)

    const manifestPath = path.join(dir, '.redesigner/manifest.json')
    const deadline = Date.now() + 10000
    let manifest = await readManifest(manifestPath)
    while (Date.now() < deadline) {
      manifest = await readManifest(manifestPath)
      const allPresent = locAttrs.every((loc) => manifest.locs[loc] !== undefined)
      if (allPresent) break
      await new Promise((r) => setTimeout(r, 100))
    }

    for (const loc of locAttrs) {
      expect(manifest.locs[loc]).toBeDefined()
    }
  }, 15000)
})
