import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ManifestSchema, SelectionFileSchema } from '@redesigner/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, '../fixtures/minimal-project')
const CLI = path.join(HERE, '../../src/cli.ts')

describe('MCP integration — SDK Client ↔ spawned cli.ts', () => {
  let client: Client
  let transport: StdioClientTransport
  let stderrChunks: string[] = []

  beforeAll(async () => {
    // Pre-test: validate fixtures against schemas.
    const manifestRaw = JSON.parse(
      readFileSync(path.join(FIXTURE, '.redesigner/manifest.json'), 'utf8'),
    )
    const m = ManifestSchema.safeParse(manifestRaw)
    if (!m.success) throw new Error(`fixture manifest invalid: ${m.error.message}`)

    const selectionRaw = JSON.parse(
      readFileSync(path.join(FIXTURE, '.redesigner/selection.json'), 'utf8'),
    )
    const s = SelectionFileSchema.safeParse(selectionRaw)
    if (!s.success) throw new Error(`fixture selection invalid: ${s.error.message}`)

    stderrChunks = []
    transport = new StdioClientTransport({
      command: 'tsx',
      args: [CLI, '--project', FIXTURE],
      stderr: 'pipe',
    })
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString('utf8'))
    })
    client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} })
    await client.connect(transport)
  })

  afterAll(async () => {
    await client.close().catch(() => {})
    await transport.close().catch(() => {})
  })

  it('tools/list returns the four selection tools', async () => {
    const res = await client.listTools()
    const names = res.tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'get_computed_styles',
      'get_current_selection',
      'get_dom_subtree',
      'list_recent_selections',
    ])
  })

  it('get_current_selection returns null when daemon absent', async () => {
    const res = await client.callTool({ name: 'get_current_selection', arguments: {} })
    const content = res.content as Array<{ type: string; text?: string }>
    const parsed = JSON.parse(content[0]?.text ?? 'null')
    // DaemonBackend returns null when handoff file missing (daemon absent)
    expect(parsed).toBe(null)
  })

  it('resources/read manifest returns fixture data', async () => {
    const res = await client.readResource({ uri: 'redesigner://project/manifest' })
    const contents = res.contents as Array<{ text?: string }>
    const manifest = JSON.parse(contents[0]?.text ?? '{}')
    expect(Object.keys(manifest.components)).toHaveLength(2)
  })

  it('unknown tool name → error', async () => {
    await expect(client.callTool({ name: 'nonexistent_tool', arguments: {} })).rejects.toThrow()
  })

  it('stderr shows resolved project root', () => {
    const joined = stderrChunks.join('')
    expect(joined).toContain('[redesigner/mcp] resolved project root:')
    expect(joined).toContain(FIXTURE)
  })
})
