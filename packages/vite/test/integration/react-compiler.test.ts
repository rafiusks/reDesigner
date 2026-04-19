import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import reactPlugin from '@vitejs/plugin-react'
import { type ESBuildOptions, type Plugin, type ViteDevServer, createServer } from 'vite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import redesigner from '../../src/index'

// ─── Task E-9: React Compiler integration (spec §8.3 row react-compiler.test.ts) ───
//
// Approach 2 — behavioural proxy (same philosophy as E-7).
//
// The spec's three concerns, rephrased at the transform level:
//   (a) Fresh render: does `data-redesigner-loc` survive the React Compiler's
//       Babel transformation pass? The compiler can restructure and memoize;
//       a broken integration would strip or mangle the attribute.
//   (b) Prop-change re-render determinism: "prop-change re-render" is a runtime
//       behaviour that cannot be simulated at the transform level. The analogous
//       transform-level invariant is: the compiler's output is DETERMINISTIC —
//       two successive transformRequest calls on the same source return identical
//       code. A compiler that over-memoised build-time decisions and served stale
//       output would produce different results on successive calls or under
//       different runtime prop sets. Determinism at build time is necessary
//       (though not sufficient) for stable runtime behaviour.
//   (c) HMR edit: a source-line shift (prepending a blank line) must produce a
//       NEW `data-redesigner-loc` value reflecting the new position. This proves
//       the compiler's transform pipeline is not over-caching stale output from
//       before the edit.
//
// Pipeline run order: redesigner() is enforce:'pre' so it injects
// `data-redesigner-loc` FIRST (Babel pass). Then plugin-react's transform runs,
// which invokes the React Compiler Babel plugin. The final composed output must
// still contain our attribute.

// Resolve to the packages/vite node_modules for React aliases.
// The tmpdir project has no react installed; we point Vite's resolver at ours.
const PKG_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..')
const REACT_DIR = path.join(PKG_ROOT, 'node_modules/react')
const REACT_DOM_DIR = path.join(PKG_ROOT, 'node_modules/react-dom')

/**
 * Source fixture used in all three scenarios.
 *
 *   Line 1: export default function App({ name }: { name: string }) {
 *   Line 2:   return (
 *   Line 3:     <div>
 *   Line 4:       <span>hello {name}</span>
 *   Line 5:     </div>
 *   Line 6:   )
 *   Line 7: }
 *
 * The `<div>` opens at line 3 and is the first JSXOpeningElement our plugin
 * visits. The `data-redesigner-loc` attribute is pushed onto that opening
 * element, encoding "src/App.tsx:3:4".
 *
 * `hello` is a plain string JSXText child. It survives every pass (compiler,
 * plugin-react, esbuild JSX compile) intact and makes a reliable probe token
 * for source-map assertions.
 */
const APP_TSX = `export default function App({ name }: { name: string }) {
  return (
    <div>
      <span>hello {name}</span>
    </div>
  )
}
`

// `      <span>hello` → 6 spaces + `<span>` (6 chars) = 12; `h` at column 12 (0-indexed).
const TOKEN = 'hello'
const TOKEN_ORIGINAL_LINE = 4 // 1-indexed

/**
 * Locate `token` in `transformedCode` and return its 1-indexed line and 0-indexed
 * column — the shape `originalPositionFor` expects for its `needle` argument.
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

/**
 * Extract the first `data-redesigner-loc` attribute value from the transformed code.
 * The compiled output may contain it as a JSX prop string or as a compiled
 * `"data-redesigner-loc": "..."` object property depending on the JSX transform
 * applied by plugin-react / esbuild.
 */
function extractLocAttr(code: string): string | undefined {
  // Match both JSX attribute form: data-redesigner-loc="..."
  // and compiled form: "data-redesigner-loc":"..."
  const m =
    code.match(/data-redesigner-loc[=:]\s*["']([^"']+)["']/) ??
    code.match(/"data-redesigner-loc":\s*"([^"]+)"/)
  return m?.[1]
}

// @vitejs/plugin-react default import: ESM interop can expose factory directly
// or as `{ default: factory }`. Guard both. Copied from sourcemap.test.ts.
function makeReactPlugins(opts?: Parameters<typeof reactPlugin>[0]): Plugin[] {
  // biome-ignore lint/suspicious/noExplicitAny: CJS/ESM interop shape varies
  const factory = ((reactPlugin as any).default ?? reactPlugin) as typeof reactPlugin
  const out = factory({
    jsxRuntime: 'automatic',
    ...opts,
  }) as unknown as Plugin | Plugin[]
  return Array.isArray(out) ? out : [out]
}

/** Build a Vite dev server with redesigner + plugin-react (+ optional React Compiler). */
async function makeServer(dir: string, withCompiler: boolean): Promise<ViteDevServer> {
  const reactOpts = withCompiler
    ? { babel: { plugins: [['babel-plugin-react-compiler', {}]] as [string, object][] } }
    : {}
  const plugins: Plugin[] = [redesigner(), ...makeReactPlugins(reactOpts)]
  return createServer({
    root: dir,
    configFile: false,
    plugins,
    esbuild: { jsx: 'automatic' } as ESBuildOptions,
    server: { port: 0, strictPort: false, middlewareMode: true, fs: { strict: false } },
    resolve: {
      alias: {
        'react/compiler-runtime': path.join(REACT_DIR, 'compiler-runtime.js'),
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

// Race-bounded close: bare server.close() can hang on macOS when the FS watcher is
// slow to release. 2s ceiling mirrors E-8/E-10/E-15.
async function safeClose(server: ViteDevServer | undefined): Promise<void> {
  if (!server) return
  await Promise.race([server.close(), new Promise<void>((r) => setTimeout(r, 2000))])
}

// Invalidate Vite's cached module for `id` so the next transformRequest re-runs the
// pipeline on the on-disk edit. Without this, Vite serves cached output.
function invalidate(server: ViteDevServer, id: string): void {
  const mod = server.moduleGraph.getModuleById(id)
  if (mod) server.moduleGraph.invalidateModule(mod)
}

describe('vite integration: react-compiler — attribute survives compiler pass + determinism + HMR shift', () => {
  let dir: string
  let server: ViteDevServer | undefined

  beforeEach(() => {
    // realpathSync: macOS /var/folders → /private/var/folders symlink must be
    // resolved so the path Vite computes for id matches the path we wrote to.
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'redesigner-compiler-')))
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'react-compiler-int-test',
        type: 'module',
        version: '0.0.0',
        private: true,
      }),
    )
    writeFileSync(path.join(dir, 'src/App.tsx'), APP_TSX)
  })

  afterEach(async () => {
    await safeClose(server)
    server = undefined
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('scenario (a): attribute present at correct source line after React Compiler pass', async () => {
    // Pipeline: redesigner (pre) → plugin-react+compiler → esbuild JSX compile.
    // redesigner injects data-redesigner-loc FIRST; the React Compiler then
    // optimises / memoises the component. The attribute must survive intact.
    server = await makeServer(dir, /* withCompiler= */ true)

    const result = await server.transformRequest('/src/App.tsx')
    expect(result).not.toBeNull()
    if (!result) return

    // (i) The attribute must still be present in the compiled output.
    expect(result.code).toContain('data-redesigner-loc')

    // (ii) The loc value must encode the correct source position.
    // The <div> opens at line 3, column 4 (0-indexed: 4 spaces before '<div>').
    // formatLoc produces "src/App.tsx:3:4".
    const locValue = extractLocAttr(result.code)
    expect(locValue).toBeDefined()
    if (!locValue) return
    // Line 3 is the <div> open tag; the format is "<relPath>:<line>:<col>".
    expect(locValue).toContain('App.tsx:3:')

    // (iii) Source-map round-trip: `hello` (JSXText child, line 4 col 12 in the
    // original) must still map back to line 4 in the source after the compiler
    // pass. This is the spec's "source line must be correct" invariant.
    // Column may drift (compiler's Babel output may shift column offsets) but
    // the line assertion is exact per spec §10 decision #40.
    expect(result.code).toContain(TOKEN)
    expect(result.map).toBeDefined()
    if (!result.map) return

    const traceMap = new TraceMap(
      result.map as unknown as ConstructorParameters<typeof TraceMap>[0],
    )
    const needle = locateInTransformed(result.code, TOKEN)
    const orig = originalPositionFor(traceMap, needle)

    expect(orig.line).toBe(TOKEN_ORIGINAL_LINE) // exact line required
    // Column sanity: non-negative, within the original line's length.
    // `      <span>hello</span>` is 24 chars; any valid mapping is < 24.
    expect(orig.column).toBeGreaterThanOrEqual(0)
    expect(orig.column).toBeLessThan(24)
  }, 30000)

  it('scenario (b): transform is deterministic — two successive calls return identical loc attrs', async () => {
    // "Prop-change re-render" is a runtime concern that cannot be simulated at
    // the transform level. The transform-level invariant that protects the spec's
    // intent is: the compiler's output is DETERMINISTIC. If the React Compiler
    // were to vary its build-time output based on runtime state, successive
    // transformRequest calls on identical source would produce different attribute
    // values — which would make prop changes at runtime appear to change the loc
    // anchor. We assert build-time determinism here; runtime prop handling is a
    // concern for compiler/runtime tests, not our plugin integration test.
    server = await makeServer(dir, /* withCompiler= */ true)

    const r1 = await server.transformRequest('/src/App.tsx')
    expect(r1).not.toBeNull()
    if (!r1) return
    expect(r1.code).toContain('data-redesigner-loc')

    // Invalidate the module so Vite re-runs the full pipeline (simulates the
    // "second render request" from a new navigation / prop change triggering a
    // fresh module evaluation in a non-cache scenario).
    const appPath = path.join(dir, 'src/App.tsx')
    invalidate(server, appPath)

    const r2 = await server.transformRequest('/src/App.tsx')
    expect(r2).not.toBeNull()
    if (!r2) return
    expect(r2.code).toContain('data-redesigner-loc')

    // Extract and compare loc attribute values from both transforms.
    const loc1 = extractLocAttr(r1.code)
    const loc2 = extractLocAttr(r2.code)
    expect(loc1).toBeDefined()
    expect(loc2).toBeDefined()
    // Determinism invariant: same source → same loc attribute. The compiler's
    // memoisation must never produce a different attribute on successive transforms.
    expect(loc1).toBe(loc2)

    // Belt-and-suspenders: verify neither result switched to a different line.
    expect(loc1).toContain('App.tsx:3:')
    expect(loc2).toContain('App.tsx:3:')
  }, 30000)

  it('scenario (c): HMR edit shifts loc — compiler pipeline not over-caching stale output', async () => {
    // A source edit that shifts all element positions (prepending a blank line)
    // must produce a NEW data-redesigner-loc value reflecting the shifted line.
    // This proves the compiler + Vite cache pipeline does not serve stale output
    // from before the edit (the spec's "HMR edit updates attribute" concern).
    server = await makeServer(dir, /* withCompiler= */ true)
    const appPath = path.join(dir, 'src/App.tsx')
    const appUrl = '/src/App.tsx'

    // Initial transform: record the loc value for the <div> (originally on line 3).
    const before = await server.transformRequest(appUrl)
    expect(before).not.toBeNull()
    if (!before) return
    expect(before.code).toContain('data-redesigner-loc')
    const locBefore = extractLocAttr(before.code)
    expect(locBefore).toBeDefined()
    if (!locBefore) return
    // Baseline: <div> is on line 3.
    expect(locBefore).toContain('App.tsx:3:')

    // Extract the line number from the loc to use as a numeric comparator.
    const lineMatch = locBefore.match(/:(\d+):/)
    expect(lineMatch).not.toBeNull()
    const lineBefore = lineMatch ? Number.parseInt(lineMatch[1] ?? '0', 10) : 0

    // Edit: prepend a blank line. <div> shifts from line 3 → line 4.
    writeFileSync(appPath, `\n${APP_TSX}`)

    // Invalidate the module cache so Vite re-runs the pipeline on the new content.
    invalidate(server, appPath)

    const after = await server.transformRequest(appUrl)
    expect(after).not.toBeNull()
    if (!after) return
    expect(after.code).toContain('data-redesigner-loc')
    const locAfter = extractLocAttr(after.code)
    expect(locAfter).toBeDefined()
    if (!locAfter) return

    // The attribute must have CHANGED — a stale-cache regression would return
    // the same :3: loc even after the source shifted the <div> to line 4.
    expect(locAfter).not.toBe(locBefore)

    // The new loc must encode the SHIFTED line number.
    const lineAfterMatch = locAfter.match(/:(\d+):/)
    expect(lineAfterMatch).not.toBeNull()
    const lineAfter = lineAfterMatch ? Number.parseInt(lineAfterMatch[1] ?? '0', 10) : 0
    expect(lineAfter).toBeGreaterThan(lineBefore)
  }, 30000)
})
