import { readFileSync } from 'node:fs'
import path from 'node:path'
import { transformAsync } from '@babel/core'
import type { Plugin, ResolvedConfig } from 'vite'
import { redesignerBabelPlugin } from './babel/plugin'
import { rejectEscapingPath, toPosixProjectRoot, toPosixRelative } from './core/pathGuards'
import type { Logger, PerFileBatch } from './core/types-internal'
import type { RedesignerOptions } from './core/types-public'
import { DaemonBridge } from './integration/daemonBridge'
import { ManifestWriter } from './integration/manifestWriter'
import { detectJsxRuntime } from './integration/runtimeDetect'

interface ClientState {
  writer: ManifestWriter
  daemon: DaemonBridge
  projectRoot: string
  manifestPath: string
  include: string[]
  exclude: string[]
}

function normalizeDaemon(input: RedesignerOptions['daemon']): {
  mode: 'auto' | 'required' | 'off'
  port: number
} {
  if (!input) return { mode: 'auto', port: 0 }
  if (typeof input === 'string') return { mode: input, port: 0 }
  return { mode: input.mode ?? 'auto', port: input.port ?? 0 }
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

      if (!(options.enabled ?? true)) {
        logger.info('[redesigner] disabled via options.enabled=false')
        return
      }

      const projectRoot = toPosixProjectRoot(config.root)
      const manifestPath = path.posix.resolve(
        projectRoot,
        options.manifestPath ?? '.redesigner/manifest.json',
      )
      rejectEscapingPath(path.posix.relative(projectRoot, manifestPath), projectRoot)

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
      client = { writer, daemon, projectRoot, manifestPath, include, exclude }
    },

    async configureServer(server) {
      if (!client) return

      await client.daemon.start({
        mode: daemonOpts.mode,
        port: daemonOpts.port,
        manifestPath: client.manifestPath,
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
