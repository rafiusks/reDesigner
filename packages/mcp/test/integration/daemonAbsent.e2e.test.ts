/**
 * E2E: MCP shim with no daemon running.
 *
 * No daemon is forked. The handoff file is absent at the discovery path.
 * DaemonBackend must short-circuit gracefully:
 *   - get_current_selection → null
 *   - list_recent_selections → []
 *   - getManifest (resource read) → works via FileBackend file read
 *
 * Also verifies: NO fetch errors bleed to stderr. DaemonBackend must NOT
 * attempt an HTTP call when the handoff file is missing.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildMinimalManifest } from '../../../daemon/test/helpers/forkDaemon.js'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MCP_CLI = path.resolve(HERE, '../../dist/cli.js')

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let projectRoot: string
let client: Client
let transport: StdioClientTransport
const stderrChunks: string[] = []

beforeAll(async () => {
  // Create a minimal project dir with a manifest but NO daemon handoff
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redesigner-mcp-absent-'))
  const manifestDir = path.join(projectRoot, '.redesigner')
  fs.mkdirSync(manifestDir, { recursive: true })
  const manifestPath = path.join(manifestDir, 'manifest.json')
  const manifestData = buildMinimalManifest({ generatedAt: new Date().toISOString() })
  fs.writeFileSync(manifestPath, JSON.stringify(manifestData), { mode: 0o600 })

  transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_CLI, '--project', projectRoot],
    stderr: 'pipe',
  })
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk.toString('utf8'))
  })
  client = new Client({ name: 'test-absent', version: '0.0.1' }, { capabilities: {} })
  await client.connect(transport)
})

afterAll(async () => {
  await client.close().catch(() => {})
  await transport.close().catch(() => {})
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true })
  } catch {}
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('daemonAbsent E2E — no daemon, handoff file absent', () => {
  it('get_current_selection returns null (daemon absent)', async () => {
    const res = await client.callTool({ name: 'get_current_selection', arguments: {} })
    const content = res.content as Array<{ type: string; text?: string }>
    const parsed: unknown = JSON.parse(content[0]?.text ?? 'undefined')
    expect(parsed).toBe(null)
  })

  it('list_recent_selections returns [] (daemon absent)', async () => {
    const res = await client.callTool({ name: 'list_recent_selections', arguments: { n: 100 } })
    const content = res.content as Array<{ type: string; text?: string }>
    const parsed: unknown = JSON.parse(content[0]?.text ?? 'undefined')
    expect(Array.isArray(parsed)).toBe(true)
    expect((parsed as unknown[]).length).toBe(0)
  })

  it('manifest resource still returns valid data (FileBackend inheritance)', async () => {
    const res = await client.readResource({ uri: 'redesigner://project/manifest' })
    const contents = res.contents as Array<{ text?: string }>
    const manifest = JSON.parse(contents[0]?.text ?? '{}') as {
      components?: Record<string, unknown>
      schemaVersion?: string
    }
    expect(manifest).toHaveProperty('schemaVersion', '1.0')
    expect(manifest).toHaveProperty('components')
    const componentKeys = Object.keys(manifest.components ?? {})
    // buildMinimalManifest seeds src/App.tsx::App
    expect(componentKeys.length).toBeGreaterThanOrEqual(1)
  })

  it('stderr must not contain fetch error or connection-refused messages', () => {
    // Give stderr a moment to drain any pending writes
    const joined = stderrChunks.join('')
    // These strings would indicate DaemonBackend tried to fetch despite missing handoff
    expect(joined).not.toContain('ECONNREFUSED')
    expect(joined).not.toContain('fetch error')
    expect(joined).not.toContain('connection failed')
  })

  it('tools/list enumerates all four tools even without daemon', async () => {
    const res = await client.listTools()
    const names = res.tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'get_computed_styles',
      'get_current_selection',
      'get_dom_subtree',
      'list_recent_selections',
    ])
  })
})
