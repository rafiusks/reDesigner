import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
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

function recordingBackend(calls: string[]): Backend {
  return new Proxy(
    {
      getManifest: async () => ({
        schemaVersion: '1.0',
        framework: 'react',
        generatedAt: '',
        contentHash: 'a'.repeat(64),
        components: {},
        locs: {},
      }),
      getCurrentSelection: async () => handle,
      getRecentSelections: async () => [handle],
      getComputedStyles: async () => null,
      getDomSubtree: async () => null,
    } as Backend,
    {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value === 'function') {
          return (...args: unknown[]) => {
            calls.push(String(prop))
            return value.apply(target, args)
          }
        }
        return value
      },
    },
  )
}

describe('server isolation — server.ts only touches the Backend', () => {
  it('exercises all tools + resources; Backend receives exactly the expected calls', async () => {
    const calls: string[] = []
    const backend = recordingBackend(calls)
    const server = buildServer(backend, {
      serverVersion: '0.1.0',
      projectName: 'test',
      manifestRelativePath: '.redesigner/manifest.json',
      viteConfigPresent: true,
    })
    const [s, c] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} })
    await Promise.all([server.connect(s), client.connect(c)])

    await client.listTools()
    await client.listResources()
    await client.callTool({ name: 'get_current_selection', arguments: {} })
    await client.callTool({ name: 'list_recent_selections', arguments: { n: 2 } })
    await client.callTool({ name: 'get_computed_styles', arguments: { selectionId: 'abc' } })
    await client.callTool({ name: 'get_dom_subtree', arguments: { selectionId: 'abc', depth: 1 } })
    await client.readResource({ uri: 'redesigner://project/manifest' })
    await client.readResource({ uri: 'redesigner://project/config' })

    expect(calls.sort()).toEqual(
      [
        'getComputedStyles',
        'getCurrentSelection',
        'getDomSubtree',
        'getManifest',
        'getRecentSelections',
      ].sort(),
    )
  })
})
