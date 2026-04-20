import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import type { Backend } from '../../src/backend'
import { buildServer } from '../../src/server'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_PATH = path.join(HERE, '../snapshots/schemas.snap.json')

function stubBackend(): Backend {
  return {
    getManifest: async () => ({
      schemaVersion: '1.0',
      framework: 'react',
      generatedAt: '',
      contentHash: 'a'.repeat(64),
      components: {},
      locs: {},
    }),
    getCurrentSelection: async () => null,
    getRecentSelections: async () => [],
    getComputedStyles: async () => null,
    getDomSubtree: async () => null,
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, sortKeys(obj[k])]),
    )
  }
  return value
}

describe('frozen-schema snapshot', () => {
  it('tools/list + resources/list match committed snapshot', async () => {
    const server = buildServer(stubBackend(), {
      serverVersion: '0.1.0',
      projectName: 'snapshot-test',
      manifestRelativePath: '.redesigner/manifest.json',
      viteConfigPresent: true,
    })
    const [s, c] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} })
    await Promise.all([server.connect(s), client.connect(c)])

    const tools = await client.listTools()
    const resources = await client.listResources()
    const actual = `${JSON.stringify(sortKeys({ tools: tools.tools, resources: resources.resources }), null, 2)}\n`

    if (process.env.UPDATE_SNAPSHOT === '1' || !existsSync(SNAPSHOT_PATH)) {
      mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true })
      writeFileSync(SNAPSHOT_PATH, actual)
      return
    }
    const expected = readFileSync(SNAPSHOT_PATH, 'utf8')
    expect(actual).toBe(expected)
  })
})
