import { readFileSync } from 'node:fs'
import path from 'node:path'
import { transformAsync } from '@babel/core'
import type { Plugin, ResolvedConfig } from 'vite'
import { redesignerBabelPlugin } from './babel/plugin'
import { rejectEscapingPath, toPosixProjectRoot, toPosixRelative } from './core/pathGuards'
import type { PerFileBatch } from './core/types-internal'
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

export default function redesigner(options: RedesignerOptions = {}): Plugin {
  const state: Map<unknown, ClientState> = new Map()
  let config: ResolvedConfig
  let initialized = false
  const include = options.include ?? ['**/*.{jsx,tsx}']
  const exclude = options.exclude ?? ['node_modules/**', '**/*.d.ts']
  const daemonOpts = normalizeDaemon(options.daemon)

  // pluginRef used inside configureServer to call closeBundle without 'this'
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

      const writerLogger: {
        info: (m: string) => void
        warn: (m: string) => void
        error: (m: string) => void
        debug?: (m: string) => void
      } = {
        info: (m) => logger.info(m),
        warn: (m) => logger.warn(m),
        error: (m) => logger.error(m),
        debug: (m) => logger.info(m),
      }

      const writer = new ManifestWriter({ projectRoot, manifestPath, logger: writerLogger })
      const daemon = new DaemonBridge()
      state.set('client', { writer, daemon, projectRoot, manifestPath, include, exclude })
      initialized = true
    },

    async configureServer(server) {
      const cs = state.get('client')
      if (!cs) return

      const daemonLogger: {
        info(m: string): void
        warn(m: string): void
        error(m: string): void
      } = {
        info: (m) => config.logger.info(m),
        warn: (m) => config.logger.warn(m),
        error: (m) => config.logger.error(m),
      }

      await cs.daemon.start({
        mode: daemonOpts.mode,
        port: daemonOpts.port,
        manifestPath: cs.manifestPath,
        // biome-ignore lint/suspicious/noExplicitAny: dynamic import path; TS static analyser requires string literal
        importer: () => import('@redesigner/daemon' as any),
        logger: daemonLogger,
      })

      server.httpServer?.on('close', () => {
        if (typeof pluginRef.closeBundle === 'function') {
          void (pluginRef.closeBundle as () => Promise<void>)()
        }
      })
    },

    async transform(code, id, transformOpts) {
      if (!initialized) return undefined
      // Environment-aware skip (Vite 6+: this.environment is typed via MinimalPluginContext)
      if (this.environment && this.environment.name !== 'client') return undefined
      if ((transformOpts as { ssr?: boolean } | undefined)?.ssr === true) return undefined
      if (!/\.(jsx|tsx)$/.test(id)) return undefined

      const cs = state.get('client')
      if (!cs) return undefined

      let relPath: string
      try {
        relPath = toPosixRelative(id, cs.projectRoot)
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
          inputSourceMap: null,
          configFile: false,
          babelrc: false,
          filename: id,
          ast: false,
        })
      } catch (err) {
        config.logger.warn(
          `[redesigner] babel parse failed for ${relPath}: ${(err as Error).message}`,
        )
        return undefined
      }

      if (!result) return undefined
      cs.writer.commitFile(relPath, batch)
      return { code: result.code ?? code, map: result.map ?? null }
    },

    async closeBundle() {
      const cs = state.get('client')
      if (!cs) return

      const daemonLogger: {
        info(m: string): void
        warn(m: string): void
        error(m: string): void
      } = {
        info: (m) => config.logger.info(m),
        warn: (m) => config.logger.warn(m),
        error: (m) => config.logger.error(m),
      }

      await cs.writer.shutdown()
      await cs.daemon.shutdown({
        mode: daemonOpts.mode,
        port: daemonOpts.port,
        manifestPath: cs.manifestPath,
        importer: () => Promise.reject(new Error('closed')),
        logger: daemonLogger,
      })
    },
  }

  return pluginRef
}
