import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import type { Backend } from '../../src/backend'
import { buildServer } from '../../src/server'

const handle = {
  id: 'abc',
  componentName: 'Foo',
  filePath: 'src/Foo.tsx',
  lineRange: [1, 5] as [number, number],
  domPath: '#root',
  parentChain: ['App'],
  timestamp: 0,
}

function makeBackend(): Backend {
  return {
    getManifest: async () => ({
      schemaVersion: '1.0',
      framework: 'react',
      generatedAt: '',
      contentHash: 'a'.repeat(64),
      components: {},
      locs: {},
    }),
    getCurrentSelection: async () => handle,
    getRecentSelections: async (n) => Array(Math.min(n, 1)).fill(handle),
    getComputedStyles: async () => null,
    getDomSubtree: async () => null,
  }
}

async function makeConnectedClient(backend: Backend) {
  const server = buildServer(backend, {
    serverVersion: '0.1.0',
    projectName: 'test',
    manifestRelativePath: '.redesigner/manifest.json',
    viteConfigPresent: true,
  })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { server, client }
}

describe('buildServer', () => {
  it('registers exactly 4 tools with frozen names', async () => {
    const { client } = await makeConnectedClient(makeBackend())
    const res = await client.listTools()
    const names = res.tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'get_computed_styles',
      'get_current_selection',
      'get_dom_subtree',
      'list_recent_selections',
    ])
  })

  it('registers exactly 2 resources with frozen URIs', async () => {
    const { client } = await makeConnectedClient(makeBackend())
    const res = await client.listResources()
    const uris = res.resources.map((r) => r.uri).sort()
    expect(uris).toEqual(['redesigner://project/config', 'redesigner://project/manifest'])
  })

  it('get_current_selection returns the handle', async () => {
    const { client } = await makeConnectedClient(makeBackend())
    const res = await client.callTool({ name: 'get_current_selection', arguments: {} })
    const content = res.content as Array<{ type: string; text?: string }>
    const text = content[0]?.text ?? ''
    expect(JSON.parse(text)).toMatchObject({ id: 'abc' })
  })

  it('list_recent_selections rejects n < 1 at the SDK layer', async () => {
    const { client } = await makeConnectedClient(makeBackend())
    await expect(
      client.callTool({ name: 'list_recent_selections', arguments: { n: 0 } }),
    ).rejects.toThrow()
  })

  it('get_computed_styles returns null in FileBackend mode', async () => {
    const { client } = await makeConnectedClient(makeBackend())
    const res = await client.callTool({
      name: 'get_computed_styles',
      arguments: { selectionId: 'abc' },
    })
    const content = res.content as Array<{ type: string; text?: string }>
    expect(JSON.parse(content[0]?.text ?? '')).toBeNull()
  })
})
