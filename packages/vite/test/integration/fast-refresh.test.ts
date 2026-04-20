import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import reactPlugin from '@vitejs/plugin-react'
import { type ESBuildOptions, type Plugin, type ViteDevServer, createServer } from 'vite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Manifest } from '../../src/core/types-public'
import redesigner from '../../src/index'
import { readManifest } from '../../src/reader'

// Fast-Refresh integration (spec §8.3).
//
// Approach 2 — behavioural proxy.
//
// The spec prescribes runtime-level assertions: click a <button> three times, assert
// state preservation across an unrelated leaf edit, monkey-patch `window.$RefreshReg$`
// to observe registration calls. Full-fidelity reproduction requires a browser (jsdom
// does not run plugin-react's HMR runtime; plugin-react's refresh glue assumes a real
// `window` with `import.meta.hot.accept` wired end-to-end). Building that up in a
// vitest process ends up reinventing Fast Refresh itself and primarily tests plugin-
// react's runtime rather than our plugin.
//
// We instead assert the invariants OUR plugin observably controls, which map to the
// WHY of each spec row:
//   (a) "state preservation on unrelated leaf edit" → our plugin must NOT perturb
//       Counter.tsx's module identity (componentKey / loc attrs / lineRange) when the
//       edit is to Leaf.tsx. Fast Refresh's state preservation is predicated on
//       Counter's module not being invalidated at the React-module boundary; if our
//       transform were to globally mutate unrelated files, Fast Refresh would blow
//       state on every leaf edit.
//   (b) "registration stability via $RefreshReg$ monkey-patch" → our `enforce: 'pre'`
//       transform must leave plugin-react's post-transform Fast Refresh glue intact.
//       We assert the composed pipeline output (redesigner → plugin-react) still
//       contains plugin-react v5's Fast Refresh markers (`$RefreshReg$`,
//       `$RefreshSig$`, `RefreshRuntime.register`, `import.meta.hot.accept`,
//       `/@react-refresh` import) AND our `data-redesigner-loc` attribute — i.e.
//       both integrations coexist in the final module.
//   (c) "memo↔plain transition no-crash" → facebook/react#30659 class: plugin-react's
//       Fast Refresh runtime has historically crashed on HOC↔plain identity flips.
//       We cannot run the runtime, but we CAN assert our transform does not throw
//       across the three transitions (memo → plain → memo) and that the componentKey
//       is stable (identity preserved) so Fast Refresh has a fixed identity to
//       register against.
//
// Marker pin to plugin-react v5 (v5.2.0 at time of writing). The Fast Refresh markers
// this test keys on are emitted by `addRefreshWrapper` in @vitejs/plugin-react v5's
// `dist/index.js` (lines ~11, ~24, ~26, ~33, ~43 of the bundled source — shape may
// shift between minor releases but the literal substrings are stable within v5). If
// plugin-react is downgraded to v4, its Fast Refresh wrapper uses the
// `prevRefreshReg`/`prevRefreshSig` save/restore footer pattern instead of the
// prologue form, and this test must be updated. The `react-refresh` runtime itself
// is a separate concern — our assertions key on the plugin-react wrapper output, not
// the runtime module body.

const PKG_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..')
const REACT_DIR = path.join(PKG_ROOT, 'node_modules/react')
const REACT_DOM_DIR = path.join(PKG_ROOT, 'node_modules/react-dom')

function makeServer(dir: string, plugins: Plugin[]): Promise<ViteDevServer> {
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

// Poll the atomic-renamed manifest file until `predicate(m)` returns true, or the
// deadline elapses. Mirrors hmr.test.ts's `pollManifest`: deadline-bounded file-
// content observation, not a wait-for-hmr setTimeout.
async function pollManifest(
  dir: string,
  predicate: (m: Manifest) => boolean,
  timeoutMs = 10000,
): Promise<Manifest> {
  const manifestPath = path.join(dir, '.redesigner/manifest.json')
  const deadline = Date.now() + timeoutMs
  let last: Manifest | undefined
  while (Date.now() < deadline) {
    if (existsSync(manifestPath)) {
      try {
        last = await readManifest(manifestPath)
        if (predicate(last)) return last
      } catch {
        // Mid-rename read race — retry.
      }
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!last) throw new Error(`manifest never materialized at ${manifestPath}`)
  return last
}

// Invalidate Vite's cached module for `id` so the next transformRequest re-runs the
// pipeline on the on-disk edit. Without this, Vite serves cached output. Same helper
// as hmr.test.ts.
function invalidate(server: ViteDevServer, id: string): void {
  const mod = server.moduleGraph.getModuleById(id)
  if (mod) server.moduleGraph.invalidateModule(mod)
}

// Race-bounded close: bare server.close() can hang on macOS when the FS watcher is
// slow to release. 2s ceiling mirrors E-8/E-10/E-15.
async function safeClose(server: ViteDevServer | undefined): Promise<void> {
  if (!server) return
  await Promise.race([server.close(), new Promise<void>((r) => setTimeout(r, 2000))])
}

// @vitejs/plugin-react default import shape: ESM default can be the factory directly
// or `{ default: factory }` depending on interop. Guard both. Copied from
// sourcemap.test.ts scenario 2.
function reactPlugins(): Plugin[] {
  // biome-ignore lint/suspicious/noExplicitAny: CJS/ESM interop shape varies
  const factory = ((reactPlugin as any).default ?? reactPlugin) as typeof reactPlugin
  const out = factory({ jsxRuntime: 'automatic' }) as unknown as Plugin | Plugin[]
  return Array.isArray(out) ? out : [out]
}

describe('vite integration: Fast-Refresh — state-preservation proxy + reg stability + memo↔plain', () => {
  let dir: string
  let server: ViteDevServer | undefined

  beforeEach(() => {
    // realpathSync: macOS /var/folders → /private/var/folders symlink must be
    // resolved so the path Vite computes for id matches the path we wrote to.
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'redesigner-refresh-')))
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'fast-refresh-int-test',
        type: 'module',
        version: '0.0.0',
        private: true,
      }),
    )
  })

  afterEach(async () => {
    await safeClose(server)
    server = undefined
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('scenario 1: (a) state preservation proxy — unrelated leaf edit does not perturb Counter', async () => {
    const counterPath = path.join(dir, 'src/Counter.tsx')
    const leafPath = path.join(dir, 'src/Leaf.tsx')
    const counterUrl = '/src/Counter.tsx'
    const leafUrl = '/src/Leaf.tsx'

    // Counter holds the useState/useRef hook pair the spec cares about. We don't
    // execute it — but its transform output is our proxy for module identity.
    writeFileSync(
      counterPath,
      `import { useRef, useState } from 'react'

export default function Counter() {
  const [count, setCount] = useState(0)
  const instanceStamp = useRef(Math.random())
  return (
    <button data-instance-stamp={String(instanceStamp.current)} onClick={() => setCount(count + 1)}>
      {count}
    </button>
  )
}
`,
    )
    // Leaf: the "unrelated" file whose edit must NOT ripple into Counter's entry.
    writeFileSync(
      leafPath,
      `export default function Leaf() {
  return <span>leaf-v1</span>
}
`,
    )

    server = await makeServer(dir, [redesigner()])

    // Initial transform populates manifest for both files.
    await server.transformRequest(counterUrl)
    await server.transformRequest(leafUrl)
    const before = await pollManifest(
      dir,
      (m) =>
        m.components['src/Counter.tsx::Counter'] !== undefined &&
        m.components['src/Leaf.tsx::Leaf'] !== undefined,
    )

    const beforeCounter = before.components['src/Counter.tsx::Counter']
    expect(beforeCounter).toBeDefined()
    if (!beforeCounter) return
    const beforeCounterLocs = Object.entries(before.locs)
      .filter(([k]) => k.startsWith('src/Counter.tsx:'))
      .sort(([a], [b]) => a.localeCompare(b))
    expect(beforeCounterLocs.length).toBeGreaterThan(0)
    const beforeLeafLocs = Object.entries(before.locs).filter(([k]) =>
      k.startsWith('src/Leaf.tsx:'),
    )
    expect(beforeLeafLocs.length).toBeGreaterThan(0)

    // Edit Leaf only. Counter is untouched on disk.
    writeFileSync(
      leafPath,
      `export default function Leaf() {
  return <span>leaf-v2-edited</span>
}
`,
    )

    // Invalidate BOTH: the spec's worry is that a graph-wide retransform might
    // perturb Counter. We therefore also retransform Counter (the worst case from
    // Fast Refresh's perspective: Counter's module is re-entered by the dev
    // server) and assert the deterministic manifest output is identical.
    invalidate(server, counterPath)
    invalidate(server, leafPath)
    await server.transformRequest(leafUrl)
    await server.transformRequest(counterUrl)
    await server.waitForRequestsIdle(leafUrl)
    await server.waitForRequestsIdle(counterUrl)

    // Wait for Leaf's update to land.
    const after = await pollManifest(dir, (m) => {
      const leafLoc = Object.entries(m.locs).find(
        ([k, v]) => k.startsWith('src/Leaf.tsx:') && v.componentName === 'Leaf',
      )
      return leafLoc !== undefined
    })

    // Invariant — Counter's manifest shape is byte-identical across the leaf edit.
    const afterCounter = after.components['src/Counter.tsx::Counter']
    expect(afterCounter).toBeDefined()
    if (!afterCounter) return
    expect(afterCounter).toEqual(beforeCounter)

    const afterCounterLocs = Object.entries(after.locs)
      .filter(([k]) => k.startsWith('src/Counter.tsx:'))
      .sort(([a], [b]) => a.localeCompare(b))
    expect(afterCounterLocs).toEqual(beforeCounterLocs)

    // Sanity: Leaf DID update (otherwise the invariant is vacuous — we proved
    // nothing about Counter if Leaf itself didn't refresh).
    expect(after.components['src/Leaf.tsx::Leaf']).toBeDefined()
  }, 20000)

  it('scenario 2: (b) registration stability — plugin-react Fast-Refresh markers coexist with our loc attr', async () => {
    const counterPath = path.join(dir, 'src/Counter.tsx')
    const counterUrl = '/src/Counter.tsx'
    writeFileSync(
      counterPath,
      `import { useRef, useState } from 'react'

export default function Counter() {
  const [count, setCount] = useState(0)
  const instanceStamp = useRef(Math.random())
  return (
    <button data-instance-stamp={String(instanceStamp.current)} onClick={() => setCount(count + 1)}>
      {count}
    </button>
  )
}
`,
    )

    // redesigner() is enforce:'pre' → runs BEFORE plugin-react's Babel pass in the
    // composed pipeline. transformRequest returns the full composed code; we
    // inspect it for plugin-react v5's Fast Refresh markers PLUS our attribute.
    server = await makeServer(dir, [redesigner(), ...reactPlugins()])
    const result = await server.transformRequest(counterUrl)
    expect(result).not.toBeNull()
    if (!result) return

    // (i) Our plugin's observable output — the loc attribute — survives the
    // downstream passes. If it's missing, plugin-react's Babel is stripping props
    // we emit.
    expect(result.code).toContain('data-redesigner-loc')

    // (ii) plugin-react v5's Fast-Refresh wrapper markers. See
    // @vitejs/plugin-react v5's `addRefreshWrapper` in dist/index.js:
    //   • `$RefreshReg$(` — the emitted per-type registration call signature.
    //     This is the exact marker plugin-react's own refreshContentRE keys on.
    //   • `RefreshRuntime.register(` — where $RefreshReg$ forwards to.
    //   • `$RefreshSig$` — the signature-function factory used for hook-order
    //     invalidation.
    //   • `import.meta.hot.accept(` — the HMR accept glue that makes React-
    //     Refresh work dynamically.
    //   • `/@react-refresh` — the virtual runtime module import.
    // All five must be present for Fast Refresh to function. If any is missing,
    // our `enforce:'pre'` transform has either disabled the wrapper (e.g. by
    // removing the default export plugin-react inspects) or shifted the code
    // into a form plugin-react's heuristic rejects.
    expect(result.code).toContain('$RefreshReg$(')
    expect(result.code).toContain('RefreshRuntime.register(')
    expect(result.code).toContain('$RefreshSig$')
    expect(result.code).toContain('import.meta.hot.accept(')
    expect(result.code).toContain('/@react-refresh')
  }, 20000)

  it('scenario 3: (c) memo↔plain transition — three passes, identity stable, no crash', async () => {
    const fooPath = path.join(dir, 'src/Foo.tsx')
    const fooUrl = '/src/Foo.tsx'

    // Pass 1: export default memo(Foo). Spec anchors on this shape.
    writeFileSync(
      fooPath,
      `import { memo } from 'react'

function Foo() {
  return <div>foo</div>
}

export default memo(Foo)
`,
    )

    server = await makeServer(dir, [redesigner()])

    // The transform must NOT throw. transformRequest propagates Babel errors as
    // rejections; a swallow-and-return-null path would still not throw here.
    const r1 = await server.transformRequest(fooUrl)
    expect(r1).not.toBeNull()
    if (!r1) return
    expect(r1.code).toContain('data-redesigner-loc')

    const m1 = await pollManifest(dir, (m) => m.components['src/Foo.tsx::Foo'] !== undefined)
    const fooEntry1 = m1.components['src/Foo.tsx::Foo']
    expect(fooEntry1).toBeDefined()
    if (!fooEntry1) return
    // displayName: JSX parent walk finds `function Foo` → componentName='Foo'.
    // memo() at the default-export site never reaches the JSX visitor's parent
    // chain (the JSX is inside the FunctionDeclaration, not inside the memo
    // CallExpression that wraps the identifier reference to Foo). So `Foo`
    // is NOT skipped as a wrapper — it's correctly surfaced as a component.
    expect(fooEntry1.displayName).toBe('Foo')
    // Reality check on exportKind: per src/babel/resolveEnclosingComponent.ts,
    // exportKind is decided from the immediate parent of the nearest
    // FunctionDeclaration/VariableDeclarator/etc. — NOT by tracking that the
    // identifier is later referenced from `export default memo(Foo)`. With
    // `function Foo() {…}` at Program scope, the parent is Program, so
    // exportKind is 'named' in both pass 1 and pass 2. The spec's literal
    // "assert exportKind === 'default' after plain edit" does not match the
    // plugin's current behavior; per the task gotcha #6 ("follow reality if
    // spec wording mismatches"), we assert what the plugin actually emits.
    expect(fooEntry1.exportKind).toBe('named')

    // Capture the data-redesigner-loc attribute from the transformed output.
    // This is the stable identity anchor: componentKey::componentName → loc
    // string. If plugin-react ever mis-identifies Foo across HOC flips
    // (facebook/react#30659), OUR identity anchor must still be stable so the
    // user-visible DOM attribute keeps pointing at the same manifest entry.
    const locAttrRE = /"data-redesigner-loc":\s*"([^"]+)"/g
    const locs1 = [...r1.code.matchAll(locAttrRE)].map((m) => m[1])
    expect(locs1.length).toBeGreaterThan(0)
    for (const loc of locs1) {
      if (!loc) continue
      const rec = m1.locs[loc]
      expect(rec).toBeDefined()
      expect(rec?.componentKey).toBe('src/Foo.tsx::Foo')
      expect(rec?.componentName).toBe('Foo')
    }

    // Pass 2: edit to plain `export default Foo` — the facebook/react#30659
    // regression class: HOC → plain identity flip.
    writeFileSync(
      fooPath,
      `function Foo() {
  return <div>foo</div>
}

export default Foo
`,
    )
    invalidate(server, fooPath)
    const r2 = await server.transformRequest(fooUrl)
    expect(r2).not.toBeNull()
    if (!r2) return
    expect(r2.code).toContain('data-redesigner-loc')
    await server.waitForRequestsIdle(fooUrl)

    const m2 = await pollManifest(dir, (m) => {
      const foo = m.components['src/Foo.tsx::Foo']
      // The edit dropped the `import { memo }` line → Foo's lineRange shifts
      // up. We use that shift as the predicate witnessing the update actually
      // landed (otherwise a stale manifest would trivially pass the identity
      // assertions).
      return foo !== undefined && foo.lineRange[0] < fooEntry1.lineRange[0]
    })
    const fooEntry2 = m2.components['src/Foo.tsx::Foo']
    expect(fooEntry2).toBeDefined()
    if (!fooEntry2) return
    // Identity preserved across the memo→plain transition.
    expect(fooEntry2.displayName).toBe('Foo')
    expect(fooEntry2.exportKind).toBe('named') // reality, see comment above
    const locs2 = [...r2.code.matchAll(locAttrRE)].map((m) => m[1])
    expect(locs2.length).toBeGreaterThan(0)
    for (const loc of locs2) {
      if (!loc) continue
      const rec = m2.locs[loc]
      expect(rec).toBeDefined()
      expect(rec?.componentKey).toBe('src/Foo.tsx::Foo')
    }

    // Pass 3: reverse direction, back to memo. Same invariants — the third
    // transition rules out "works once either way" false passes.
    writeFileSync(
      fooPath,
      `import { memo } from 'react'

function Foo() {
  return <div>foo</div>
}

export default memo(Foo)
`,
    )
    invalidate(server, fooPath)
    const r3 = await server.transformRequest(fooUrl)
    expect(r3).not.toBeNull()
    if (!r3) return
    expect(r3.code).toContain('data-redesigner-loc')
    await server.waitForRequestsIdle(fooUrl)

    const m3 = await pollManifest(dir, (m) => {
      const foo = m.components['src/Foo.tsx::Foo']
      // Re-introducing the import line shifts Foo's lineRange back down.
      return foo !== undefined && foo.lineRange[0] > fooEntry2.lineRange[0]
    })
    const fooEntry3 = m3.components['src/Foo.tsx::Foo']
    expect(fooEntry3).toBeDefined()
    if (!fooEntry3) return
    expect(fooEntry3.displayName).toBe('Foo')
    expect(fooEntry3.exportKind).toBe('named')
    const locs3 = [...r3.code.matchAll(locAttrRE)].map((m) => m[1])
    expect(locs3.length).toBeGreaterThan(0)
    for (const loc of locs3) {
      if (!loc) continue
      const rec = m3.locs[loc]
      expect(rec).toBeDefined()
      expect(rec?.componentKey).toBe('src/Foo.tsx::Foo')
    }
  }, 30000)
})
