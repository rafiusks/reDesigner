import { parseArgs } from 'node:util'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { FileBackend } from './backend'
import { resolveConfig } from './config'
import { buildServer } from './server'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      manifest: { type: 'string' },
    },
    strict: true,
  })

  const config = resolveConfig(values, process.cwd(), process.env)
  const backend = new FileBackend({
    projectRoot: config.projectRoot,
    manifestPath: config.manifestPath,
    selectionPath: config.selectionPath,
  })
  const server = buildServer(backend, {
    serverVersion: config.serverVersion,
    projectName: config.packageJson.name ?? 'unknown',
    manifestRelativePath: config.manifestRelativePath,
    viteConfigPresent: config.viteConfigPresent,
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)

  const shutdown = async (signal: string) => {
    process.stderr.write(`[redesigner/mcp] received ${signal}, shutting down\n`)
    try {
      await server.close()
    } catch {}
    process.exit(0)
  }
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
}

main().catch((err) => {
  process.stderr.write(`[redesigner/mcp] fatal: ${(err as Error).message}\n`)
  process.exit(1)
})
