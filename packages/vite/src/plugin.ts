import { readFileSync } from 'node:fs'
import path from 'node:path'
import { transformAsync } from '@babel/core'
import { EditorSchema } from '@redesigner/core/schemas'
import type { Plugin, ResolvedConfig } from 'vite'
import viteManifest from 'vite/package.json' with { type: 'json' }
import { redesignerBabelPlugin } from './babel/plugin'
import {
  type BootstrapState,
  HANDSHAKE_PATH,
  createBootstrapState,
  createHandshakeMiddleware,
} from './bootstrap'
import { rejectEscapingPath, toPosixRelative } from './core/pathGuards'
import type { Logger, PerFileBatch } from './core/types-internal'
import type { Editor, RedesignerOptions } from './core/types-public'
import { DaemonBridge } from './integration/daemonBridge'
import { ManifestWriter } from './integration/manifestWriter'
import { detectJsxRuntime } from './integration/runtimeDetect'
import { checkViteVersion } from './viteVersionCheck'

/**
 * Plugin version — emitted on `/__redesigner/handshake.json` and injected into
 * the `<meta name="redesigner-daemon">` tag. Kept as a module constant rather
 * than a JSON import to avoid a build-time dependency on JSON modules and to
 * match what the built artifact ships (tsup targets a string literal output;
 * no runtime I/O).
 */
export const PLUGIN_VERSION = '0.0.0'

/**
 * Encode a JSON string for safe embedding inside a single-quote-delimited HTML
 * attribute value (i.e. content='...'). JSON naturally uses double-quotes for
 * keys/values, which are safe inside single-quote delimiters and must NOT be
 * escaped (doing so would break JSON.parse on the consumer side). Only the
 * characters that can break a single-quote-delimited attribute need escaping:
 *   &  →  &amp;   (prevents entity injection)
 *   <  →  &lt;    (prevents tag break-out)
 *   >  →  &gt;    (belt-and-suspenders)
 *   '  →  &#39;   (closes the outer attribute delimiter)
 */
function escapeHtmlAttrSingleQuote(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;')
}

interface ClientState {
  writer: ManifestWriter
  daemon: DaemonBridge
  projectRoot: string
  manifestPath: string
  include: string[]
  exclude: string[]
  bootstrap: BootstrapState
  editor: Editor
}

function resolveEditor(
  input: RedesignerOptions['editor'],
  logger: ResolvedConfig['logger'],
): Editor {
  if (input === undefined) return 'vscode'
  const parsed = EditorSchema.safeParse(input)
  if (parsed.success) return parsed.data
  logger.warn(
    `[redesigner] options.editor '${String(input)}' is not a known editor; falling back to 'vscode'`,
  )
  return 'vscode'
}

function normalizeDaemon(input: RedesignerOptions['daemon']): {
  mode: 'auto' | 'required' | 'off'
} {
  if (!input) return { mode: 'auto' }
  if (typeof input === 'string') return { mode: input }
  return { mode: input.mode ?? 'auto' }
}

function loadTsconfig(root: string): unknown {
  const tsconfigPath = path.join(root, 'tsconfig.json')
  try {
    const raw = readFileSync(tsconfigPath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * Read the live port from Vite's HTTP server. Returns null in middlewareMode (no
 * server) or before `listen()` resolves. The handshake middleware treats null as
 * a signal to reject with 421 since we cannot verify the Host header's authority.
 */
function viteServerPort(server: { httpServer?: { address(): unknown } | null }): number | null {
  const addr = server.httpServer?.address?.()
  if (!addr || typeof addr !== 'object') return null
  const port = (addr as { port?: unknown }).port
  return typeof port === 'number' ? port : null
}

function makeLogger(viteLogger: ResolvedConfig['logger']): Logger {
  return {
    info: (m) => viteLogger.info(m),
    warn: (m) => viteLogger.warn(m),
    error: (m) => viteLogger.error(m),
    debug: (m) => viteLogger.info(m),
  }
}

export default function redesigner(options: RedesignerOptions = {}): Plugin {
  let client: ClientState | null = null
  let config: ResolvedConfig
  const include = options.include ?? ['**/*.{jsx,tsx}']
  const exclude = options.exclude ?? ['node_modules/**', '**/*.d.ts']
  const daemonOpts = normalizeDaemon(options.daemon)

  const pluginRef: Plugin = {
    name: 'redesigner',
    enforce: 'pre',
    apply: 'serve',

    configResolved(resolvedConfig) {
      config = resolvedConfig
      const logger = config.logger

      // CVE gate: refuse to start on Vite versions with known path-traversal
      // and source-access vulnerabilities.
      checkViteVersion((viteManifest as { version: string }).version)

      if (!(options.enabled ?? true)) {
        logger.info('[redesigner] disabled via options.enabled=false')
        return
      }

      // Paths used for filesystem ops must stay native so Windows drive letters
      // are handled correctly. toPosixRelative handles posix conversion per-call
      // when computing manifest keys.
      const projectRoot = path.resolve(config.root)
      const manifestPath = path.resolve(
        projectRoot,
        options.manifestPath ?? '.redesigner/manifest.json',
      )
      rejectEscapingPath(path.relative(projectRoot, manifestPath), projectRoot)

      const tsconfig = loadTsconfig(config.root)
      const tsconfigTyped = tsconfig as { compilerOptions?: { jsx?: string } } | undefined
      const runtime = detectJsxRuntime({
        esbuild: config.esbuild as { jsx?: string },
        plugins: config.plugins as Array<{ name?: string }>,
        ...(tsconfigTyped !== undefined ? { tsconfig: tsconfigTyped } : {}),
      })
      if (runtime.runtime === 'classic' && runtime.source !== 'default') {
        throw new Error(
          `[redesigner] classic JSX runtime detected in ${runtime.source}; v0 requires the automatic runtime. Set \`esbuild.jsx: 'automatic'\` in vite.config, or ensure @vitejs/plugin-react uses the automatic runtime.`,
        )
      }
      if (runtime.tsconfigHint === 'classic') {
        logger.info(
          '[redesigner] tsconfig hints at classic JSX runtime, but Vite/esbuild/plugin-react use automatic — proceeding.',
        )
      }

      const writer = new ManifestWriter({
        projectRoot,
        manifestPath,
        logger: makeLogger(logger),
      })
      const daemon = new DaemonBridge()
      const bootstrap = createBootstrapState()
      const editor = resolveEditor(options.editor, logger)
      client = {
        writer,
        daemon,
        projectRoot,
        manifestPath,
        include,
        exclude,
        bootstrap,
        editor,
      }
    },

    async configureServer(server) {
      if (!client) return
      const c = client

      // Register the handshake route BEFORE starting the daemon so that requests
      // that arrive during the (async) daemon bring-up hit the middleware — it
      // degrades to 503 `extension-disconnected` until the handoff is readable.
      //
      // `server.middlewares.use(path, handler)` registers onto the connect stack
      // at call-time; Vite's SPA fallback only runs for requests that would
      // otherwise 404, so our 2xx/4xx responses short-circuit correctly.
      const handshake = createHandshakeMiddleware({
        viteServerPort: () => viteServerPort(server),
        bootstrap: c.bootstrap,
        getDaemonInfo: () => c.daemon.getDaemonInfo(),
        pluginVersion: PLUGIN_VERSION,
        editor: c.editor,
      })
      server.middlewares.use(HANDSHAKE_PATH, handshake)

      await c.daemon.start({
        mode: daemonOpts.mode,
        projectRoot: c.projectRoot,
        manifestPath: c.manifestPath,
        // biome-ignore lint/suspicious/noExplicitAny: dynamic import path; TS static analyser requires string literal
        importer: () => import('@redesigner/daemon' as any),
        logger: makeLogger(config.logger),
      })

      server.httpServer?.on('close', () => {
        if (typeof pluginRef.closeBundle === 'function') {
          void (pluginRef.closeBundle as () => Promise<void>)()
        }
      })
    },

    async transform(code, id, transformOpts) {
      if (!client) return undefined
      if (this.environment && this.environment.name !== 'client') return undefined
      if ((transformOpts as { ssr?: boolean } | undefined)?.ssr === true) return undefined
      if (!/\.(jsx|tsx)$/.test(id)) return undefined

      let relPath: string
      try {
        relPath = toPosixRelative(id, client.projectRoot)
      } catch (err) {
        config.logger.warn(
          `[redesigner] path normalization failed for ${id}: ${(err as Error).message}`,
        )
        return undefined
      }

      const batch: PerFileBatch = { filePath: relPath, components: {}, locs: {} }
      let result: Awaited<ReturnType<typeof transformAsync>>
      try {
        result = await transformAsync(code, {
          plugins: [[() => redesignerBabelPlugin({ relPath, batch }), {}]],
          sourceMaps: true,
          inputSourceMap: undefined,
          configFile: false,
          babelrc: false,
          filename: id,
          ast: false,
          parserOpts: { plugins: ['jsx', 'typescript'] },
        })
      } catch (err) {
        config.logger.warn(
          `[redesigner] babel parse failed for ${relPath}: ${(err as Error).message}`,
        )
        return undefined
      }

      if (!result) return undefined
      client.writer.commitFile(relPath, batch)
      return { code: result.code ?? code, map: result.map ?? null }
    },

    transformIndexHtml: {
      order: 'pre',
      // `apply: 'serve'` on the plugin already gates this to dev mode, but
      // explicitly guard here too so the hook is a no-op if somehow called
      // outside a serving context.
      handler(html) {
        if (!client) return html
        const daemonInfo = client.daemon.getDaemonInfo()
        // Include all 6 HandshakeSchema fields. When the daemon hasn't started
        // yet daemonVersion defaults to 'unknown'; the extension can check
        // the handshake endpoint for authoritative values.
        const payload = {
          wsUrl: daemonInfo ? `ws://127.0.0.1:${daemonInfo.port}/events` : '',
          httpUrl: daemonInfo ? `http://127.0.0.1:${daemonInfo.port}` : '',
          bootstrapToken: String(client.bootstrap.current()),
          editor: client.editor,
          pluginVersion: PLUGIN_VERSION,
          daemonVersion: daemonInfo?.serverVersion ?? 'unknown',
        }
        const escaped = escapeHtmlAttrSingleQuote(JSON.stringify(payload))
        const tag = `<meta name="redesigner-daemon" content='${escaped}'>`
        return html.replace('<head>', `<head>\n  ${tag}`)
      },
    },

    async closeBundle() {
      if (!client) return
      const logger = makeLogger(config.logger)
      const c = client
      client = null
      await c.writer.shutdown()
      await c.daemon.shutdown({ logger })
    },
  }

  return pluginRef
}
