import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import reactPlugin from '@vitejs/plugin-react'
import { type ESBuildOptions, type Plugin, type ViteDevServer, createServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import redesigner from '../../src/index'

const PKG_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..')
const REACT_DIR = path.join(PKG_ROOT, 'node_modules/react')
const REACT_DOM_DIR = path.join(PKG_ROOT, 'node_modules/react-dom')

/**
 * Source used in both scenarios. Lines are 1-indexed, columns are 0-indexed
 * (the source-map convention — 1-based lines, 0-based columns).
 *
 *   Line 1: export default function App() {
 *   Line 2:   return (
 *   Line 3:     <div>
 *   Line 4:       <span>hello</span>
 *   Line 5:     </div>
 *   Line 6:   )
 *   Line 7: }
 *
 * Injection points: the Babel plugin pushes a `data-redesigner-loc` attribute onto
 * every non-wrapper `JSXOpeningElement`. So attributes are injected on line 3 (<div>)
 * and line 4 (<span>) — columns on THOSE lines shift for the opening tag itself.
 *
 * Why not probe `</div>` on line 5 (a different line entirely)? Vite's default
 * TSX pipeline ends with esbuild's automatic-runtime JSX compile, which rewrites
 * `<div>…</div>` → `jsxDEV("div", { … }, …)` — the literal `</div>` substring is
 * gone from the output we can probe. So we pick `hello`: a JSXText child that
 * becomes the string `"hello"` in the compiled output (survives JSX compile) AND
 * sits to the right of the `<span>` injection on line 4 — the "token after the
 * injection point" the spec prescribes for column-drift detection. The source
 * map must still point back at (line 4, column 12) despite the injected attribute
 * widening the opening tag to its left.
 */
const APP_TSX = `export default function App() {
  return (
    <div>
      <span>hello</span>
    </div>
  )
}
`

// `      <span>hello` → 6 spaces + `<span>` (6 chars) = 12; `h` at column 12 (0-indexed).
const TOKEN = 'hello'
const TOKEN_ORIGINAL_LINE = 4 // 1-indexed
const TOKEN_ORIGINAL_COLUMN = 12 // 0-indexed

/**
 * Locate `token` in `transformedCode` and return its 1-indexed line and 0-indexed
 * column — the shape `originalPositionFor` expects for its `needle` argument.
 * Splitting on `\n` matches the line-counting convention source maps use.
 */
function locateInTransformed(
  transformedCode: string,
  token: string,
): { line: number; column: number } {
  const idx = transformedCode.indexOf(token)
  if (idx < 0) {
    throw new Error(`token ${JSON.stringify(token)} not found in transformed code`)
  }
  const before = transformedCode.slice(0, idx)
  const lineIdx = before.split('\n').length - 1 // 0-indexed line of match start
  const lastNl = before.lastIndexOf('\n')
  const column = lastNl < 0 ? idx : idx - (lastNl + 1)
  return { line: lineIdx + 1, column } // line 1-indexed for originalPositionFor
}

describe('vite integration: sourcemap — column accuracy + composed-map', () => {
  let dir: string

  beforeAll(() => {
    // realpathSync on macOS: /var/folders → /private/var/folders symlink must be
    // resolved so the id Vite computes matches the path we wrote to.
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'redesigner-sourcemap-')))
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, 'src/App.tsx'), APP_TSX)
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'vite-sourcemap-test',
        type: 'module',
        version: '0.0.0',
        private: true,
      }),
    )
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  // A shared server factory keeps the two scenarios isolated (separate Vite
  // instances, separate plugin pipelines) while still reusing the same tmpdir
  // source. Each scenario owns its server lifecycle.
  async function makeServer(plugins: Plugin[]): Promise<ViteDevServer> {
    return createServer({
      root: dir,
      configFile: false,
      plugins,
      esbuild: { jsx: 'automatic' } as ESBuildOptions,
      server: { port: 0, strictPort: false, middlewareMode: true, fs: { strict: false } },
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
  }

  it('scenario 1: pre-downstream map — `hello` maps back to (4, 12) exactly', async () => {
    // Only our plugin (plus esbuild's built-in JSX→jsxDEV compile that Vite runs
    // for every .tsx). `transformRequest` returns the composed pipeline result;
    // with no OTHER source-map-producing plugins in the chain, this exercises
    // our Babel-emitted map composed with esbuild's JSX-compile map — the map
    // Vite would serve if someone built a project with only redesigner().
    const server = await makeServer([redesigner()])
    try {
      const result = await server.transformRequest('/src/App.tsx')
      expect(result).not.toBeNull()
      if (!result) return
      expect(result.map).toBeDefined()
      expect(result.map).not.toBeNull()
      if (!result.map) return

      // Sanity: the string literal `hello` survives esbuild's JSX compile as
      // `children: "hello"`. If this fails, esbuild's automatic-runtime output
      // shape changed — re-pick the token.
      expect(result.code).toContain(TOKEN)

      const traceMap = new TraceMap(
        result.map as unknown as ConstructorParameters<typeof TraceMap>[0],
      )
      const needle = locateInTransformed(result.code, TOKEN)
      const orig = originalPositionFor(traceMap, needle)

      // Exact match: the spec demands columns survive, not just lines. A broken
      // inputSourceMap wiring, or a Babel pass that regenerated loc info from
      // scratch, would return the wrong column here even if the line was right.
      // Crucially: the <span> on line 4 HAD an attribute injected at col 6, but
      // `hello` (the JSXText child to its right) must still map back to col 12
      // because the JSXText node carries its own source location, untouched by
      // the attribute insertion at the opening element.
      expect(orig.line).toBe(TOKEN_ORIGINAL_LINE)
      expect(orig.column).toBe(TOKEN_ORIGINAL_COLUMN)
    } finally {
      // Race-bounded close: bare server.close() can hang on macOS when the FS
      // watcher is slow to release. 2s ceiling mirrors E-8/E-15.
      await Promise.race([server.close(), new Promise<void>((r) => setTimeout(r, 2000))])
    }
  }, 20000)

  it('scenario 2: composed map (redesigner + plugin-react) — `hello` still maps back to line 4', async () => {
    // plugin-react 5 defaults to the automatic runtime; passing { jsxRuntime:'automatic' }
    // is explicit belt-and-braces against its hard-error on classic detection. The
    // @vitejs/plugin-react default import from an ESM context returns either the
    // factory directly or `{ default: factory }` depending on Node interop — guard
    // both forms so this test is resilient across resolver quirks.
    // biome-ignore lint/suspicious/noExplicitAny: CJS/ESM interop shape varies
    const reactFactory = ((reactPlugin as any).default ?? reactPlugin) as typeof reactPlugin
    const reactPlugins = reactFactory({ jsxRuntime: 'automatic' }) as unknown as Plugin | Plugin[]
    const plugins: Plugin[] = Array.isArray(reactPlugins) ? reactPlugins : [reactPlugins]
    // redesigner() is enforce:'pre' so pipeline order is: redesigner → plugin-react
    // Babel pass → esbuild JSX compile. `transformRequest` returns the composed
    // output + composed map (Vite pipes maps through `combineSourcemaps` internally).
    // This is the map the browser's DevTools would receive — the user-visible contract.
    const server = await makeServer([redesigner(), ...plugins])
    try {
      const result = await server.transformRequest('/src/App.tsx')
      expect(result).not.toBeNull()
      if (!result) return
      expect(result.map).toBeDefined()
      expect(result.map).not.toBeNull()
      if (!result.map) return

      // `hello` survives every downstream pass unchanged because it's a plain
      // string child of the <span>, not JSX syntax.
      expect(result.code).toContain(TOKEN)

      const traceMap = new TraceMap(
        result.map as unknown as ConstructorParameters<typeof TraceMap>[0],
      )
      const needle = locateInTransformed(result.code, TOKEN)
      const orig = originalPositionFor(traceMap, needle)

      // Per spec §10 decision #40 and the row's "column may be less precise after
      // Babel, but the line MUST be correct" language: assert line-exact. The
      // column assertion is relaxed — plugin-react's React-Refresh wrapping +
      // fast-refresh transform can shift nearby segments; the user-visible
      // contract from the spec is only that DevTools jumps to the right LINE.
      expect(orig.line).toBe(TOKEN_ORIGINAL_LINE)
      // Column sanity: must be a non-negative integer pointing somewhere on the
      // original line (the original line `      <span>hello</span>` is 24 chars
      // long). This catches a map that silently returns -1 or NaN.
      expect(orig.column).toBeGreaterThanOrEqual(0)
      expect(orig.column).toBeLessThan(24)
    } finally {
      await Promise.race([server.close(), new Promise<void>((r) => setTimeout(r, 2000))])
    }
  }, 20000)
})
