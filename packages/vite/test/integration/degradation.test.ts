import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  type ESBuildOptions,
  type InlineConfig,
  type Logger,
  type ViteDevServer,
  createServer,
} from 'vite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import redesigner from '../../src/index'

const execFileAsync = promisify(execFile)

const PKG_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..')
const REACT_DIR = path.join(PKG_ROOT, 'node_modules/react')

const APP_SOURCE = `export default function App() {
  return <div><span>hello</span></div>
}
`

// Build a minimal ViteDevServer config shared across scenarios.
// The tmpdir project has no React installed; point Vite's resolver at our own so
// transformRequest can fully compile JSX without import-resolution failures.
function baseServerConfig(dir: string, extra: Partial<InlineConfig> = {}): InlineConfig {
  return {
    root: dir,
    configFile: false,
    esbuild: { jsx: 'automatic' } as ESBuildOptions,
    server: { port: 0, strictPort: false, middlewareMode: true, fs: { strict: false } },
    resolve: {
      alias: {
        'react/jsx-dev-runtime': path.join(REACT_DIR, 'jsx-dev-runtime.js'),
        'react/jsx-runtime': path.join(REACT_DIR, 'jsx-runtime.js'),
        react: path.join(REACT_DIR, 'index.js'),
      },
    },
    clearScreen: false,
    ...extra,
  }
}

// Scaffold a minimal tmpdir project with a single src/App.tsx file.
function scaffoldProject(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, 'src/App.tsx'), APP_SOURCE)
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'degradation-test', type: 'module', version: '0.0.0', private: true }),
  )
  return dir
}

// Race server.close() against a 2s ceiling to avoid macOS watcher hang.
async function safeClose(server: ViteDevServer | undefined): Promise<void> {
  if (!server) return
  await Promise.race([server.close(), new Promise<void>((r) => setTimeout(r, 2000))])
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1 — daemon: 'off' — plugin skips daemon entirely, transforms work
// ─────────────────────────────────────────────────────────────────────────────
describe('degradation: daemon off', () => {
  let dir: string
  let server: ViteDevServer

  beforeEach(async () => {
    dir = scaffoldProject('redesigner-degrade-off-')
    server = await createServer({
      ...baseServerConfig(dir),
      plugins: [redesigner({ daemon: 'off' })],
    })
  }, 15000)

  afterEach(async () => {
    await safeClose(server)
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 10000)

  it("daemon: 'off' — plugin transforms work and daemon was never started", async () => {
    const result = await server.transformRequest('/src/App.tsx')
    expect(result).not.toBeNull()
    if (!result) return
    // The Babel plugin must have injected data-redesigner-loc attributes.
    expect(result.code).toContain('data-redesigner-loc')
  }, 15000)
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2 — daemon: 'auto' (default) with daemon package absent → warn, transforms still work
// ─────────────────────────────────────────────────────────────────────────────
describe('degradation: daemon auto (package absent)', () => {
  let dir: string
  let server: ViteDevServer
  const warnings: string[] = []

  beforeEach(async () => {
    dir = scaffoldProject('redesigner-degrade-auto-')
    warnings.length = 0

    // Vite's customLogger must implement the full Logger interface.
    const customLogger: Logger = {
      info: vi.fn(),
      warn: (_msg: string) => {
        warnings.push(_msg)
      },
      warnOnce: vi.fn(),
      error: vi.fn(),
      clearScreen: vi.fn(),
      hasErrorLogged: vi.fn(() => false),
      hasWarned: false,
    }

    server = await createServer({
      ...baseServerConfig(dir, { customLogger }),
      plugins: [redesigner({})],
    })
  }, 15000)

  afterEach(async () => {
    await safeClose(server)
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 10000)

  it("daemon: 'auto' with absent package — warns once, transforms still valid", async () => {
    const result = await server.transformRequest('/src/App.tsx')
    expect(result).not.toBeNull()
    if (!result) return
    // Transform output must contain injected loc attributes.
    expect(result.code).toContain('data-redesigner-loc')

    // The daemon start is awaited in configureServer before transformRequest is called, so by
    // the time we get here at least one warning about the absent package must exist.
    const daemonWarning = warnings.find(
      (w) =>
        w.includes('daemon package not installed') ||
        w.includes('daemon package errored on import'),
    )
    expect(daemonWarning).toBeDefined()
  }, 15000)
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3 — daemon: 'required' with daemon package absent → throws during configureServer
//
// Inside vitest/vite-node the plugin's `import('@redesigner/daemon')` is intercepted by
// Vite's dev-server module runner and returns a generic transform error (no code:
// ERR_MODULE_NOT_FOUND). This means DaemonBridge's 'required' throw path is never
// reached from within the vitest process. To get native Node resolution — which does
// produce ERR_MODULE_NOT_FOUND — we spawn a subprocess that loads the built
// dist/index.js and calls createServer directly, outside of vite-node interception.
// ─────────────────────────────────────────────────────────────────────────────
describe('degradation: daemon required (package absent)', () => {
  let dir: string

  beforeEach(() => {
    dir = scaffoldProject('redesigner-degrade-req-')
  })

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 10000)

  it("daemon: 'required' with absent package — throws with daemon required message", async () => {
    // The script below is run as a native Node subprocess (no vite-node interception).
    // It imports the built dist/index.js so the plugin's dynamic import resolves
    // through native Node — producing ERR_MODULE_NOT_FOUND — not through vite-node.
    const DIST_PLUGIN = path.resolve(PKG_ROOT, 'dist/index.js')
    const VITE_INDEX = path.resolve(PKG_ROOT, 'node_modules/vite/dist/node/index.js')
    const REACT_DEV_RUNTIME = path.join(REACT_DIR, 'jsx-dev-runtime.js')
    const REACT_JSX_RUNTIME = path.join(REACT_DIR, 'jsx-runtime.js')
    const REACT_INDEX = path.join(REACT_DIR, 'index.js')

    // Use absolute imports for both vite and the plugin so the .mjs script can live
    // anywhere without needing node_modules in its parent tree.
    const script = `
import { createServer } from ${JSON.stringify(VITE_INDEX)};
import { default as redesigner } from ${JSON.stringify(DIST_PLUGIN)};

try {
  const server = await createServer({
    root: ${JSON.stringify(dir)},
    configFile: false,
    esbuild: { jsx: 'automatic' },
    server: { port: 0, strictPort: false, middlewareMode: true, fs: { strict: false } },
    resolve: {
      alias: {
        'react/jsx-dev-runtime': ${JSON.stringify(REACT_DEV_RUNTIME)},
        'react/jsx-runtime': ${JSON.stringify(REACT_JSX_RUNTIME)},
        react: ${JSON.stringify(REACT_INDEX)},
      },
    },
    clearScreen: false,
    plugins: [redesigner({ daemon: 'required' })],
  });
  // Should not reach here — close defensively and signal unexpected success.
  await Promise.race([server.close(), new Promise(r => setTimeout(r, 2000))]);
  process.stdout.write('RESOLVED\\n');
  process.exit(0);
} catch (err) {
  process.stdout.write('REJECTED:' + err.message + '\\n');
  process.exit(0);
}
`
    // Write the script to a .mjs file so Node resolves it as ESM without needing
    // --input-type=module + stdin (stdin pipe can hang when spawned from within vitest's
    // vite-node environment due to how vite-node wraps stdin/stdio descriptors).
    const scriptPath = path.join(dir, '_required-test.mjs')
    writeFileSync(scriptPath, script)

    let stdout = ''
    let stderr = ''
    try {
      const result = await execFileAsync(process.execPath, [scriptPath], {
        timeout: 14000,
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      })
      stdout = result.stdout
      stderr = result.stderr
    } catch (execErr: unknown) {
      const e = execErr as { stdout?: string; stderr?: string; message?: string }
      stdout = e.stdout ?? ''
      stderr = e.stderr ?? ''
      // Re-throw if the subprocess produced no useful output — something structural went wrong.
      if (!stdout.includes('REJECTED') && !stdout.includes('RESOLVED')) {
        throw new Error(
          `Subprocess failed without expected output. stderr: ${stderr.substring(0, 500)}`,
        )
      }
    } finally {
      try {
        unlinkSync(scriptPath)
      } catch {}
    }

    const output = stdout.trim()
    expect(output).toMatch(/^REJECTED:/)
    expect(output).toMatch(/daemon required but not installed/i)
  }, 15000)
})
