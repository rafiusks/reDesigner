import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { SELECTION_ID_RE } from '@redesigner/core'
import { z } from 'zod'
import type { Backend } from './backend'

export interface ServerContext {
  serverVersion: string
  projectName: string
  manifestRelativePath: string
  viteConfigPresent: boolean
}

const MANIFEST_URI = 'redesigner://project/manifest'
const CONFIG_URI = 'redesigner://project/config'
const MCP_PROTOCOL_VERSION = '2025-06-18'

const GetCurrentSelectionInput = z.object({}).strict()
const ListRecentSelectionsInput = z.object({ n: z.number().int().min(1).max(100) }).strict()
const GetComputedStylesInput = z.object({ selectionId: z.string().regex(SELECTION_ID_RE) }).strict()
const GetDomSubtreeInput = z
  .object({
    selectionId: z.string().regex(SELECTION_ID_RE),
    depth: z.number().int().min(0).max(10),
  })
  .strict()

function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // Zod v4 exposes a native JSON Schema converter. Strip the `$schema`
  // metadata so the output is a clean MCP inputSchema (just
  // type/properties/required/additionalProperties).
  const { $schema: _discard, ...rest } = z.toJSONSchema(schema) as Record<string, unknown> & {
    $schema?: string
  }
  return rest
}

export function buildServer(backend: Backend, ctx: ServerContext): Server {
  const server = new Server(
    { name: '@redesigner/mcp', version: ctx.serverVersion },
    { capabilities: { tools: {}, resources: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_current_selection',
        description:
          'Returns the currently selected component, or null if nothing is currently selected.',
        inputSchema: toJsonSchema(GetCurrentSelectionInput),
      },
      {
        name: 'list_recent_selections',
        description:
          'Returns up to the n most-recent selections, newest first. Returns an empty array if no selections have been made.',
        inputSchema: toJsonSchema(ListRecentSelectionsInput),
      },
      {
        name: 'get_computed_styles',
        description:
          'Returns computed CSS styles for the selection referenced by `selectionId` (the `id` field of a `ComponentHandle` returned by `get_current_selection` or `list_recent_selections`). Returns null if the style information is not currently available.',
        inputSchema: toJsonSchema(GetComputedStylesInput),
      },
      {
        name: 'get_dom_subtree',
        description:
          'Returns a serialized DOM subtree rooted at the selection referenced by `selectionId` (the `id` field of a `ComponentHandle` returned by `get_current_selection` or `list_recent_selections`), up to `depth` levels deep. Returns null if the subtree is not currently available.',
        inputSchema: toJsonSchema(GetDomSubtreeInput),
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    switch (req.params.name) {
      case 'get_current_selection': {
        GetCurrentSelectionInput.parse(req.params.arguments ?? {})
        const result = await backend.getCurrentSelection()
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      }
      case 'list_recent_selections': {
        const { n } = ListRecentSelectionsInput.parse(req.params.arguments ?? {})
        const result = await backend.getRecentSelections(n)
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      }
      case 'get_computed_styles': {
        const { selectionId } = GetComputedStylesInput.parse(req.params.arguments ?? {})
        const result = await backend.getComputedStyles(selectionId)
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      }
      case 'get_dom_subtree': {
        const { selectionId, depth } = GetDomSubtreeInput.parse(req.params.arguments ?? {})
        const result = await backend.getDomSubtree(selectionId, depth)
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      }
      default:
        throw new Error(`unknown tool: ${req.params.name}`)
    }
  })

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: MANIFEST_URI,
        name: 'Project Manifest',
        description: 'Full component manifest produced by the Vite plugin',
        mimeType: 'application/json',
      },
      {
        uri: CONFIG_URI,
        name: 'Project Configuration',
        description: 'Detected framework, project name, MCP server version',
        mimeType: 'application/json',
      },
    ],
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri === MANIFEST_URI) {
      const manifest = await backend.getManifest()
      return {
        contents: [
          {
            uri: MANIFEST_URI,
            mimeType: 'application/json',
            text: JSON.stringify(manifest, null, 2),
          },
        ],
      }
    }
    if (req.params.uri === CONFIG_URI) {
      const cfg = {
        framework: 'react' as const,
        projectName: ctx.projectName,
        manifestRelativePath: ctx.manifestRelativePath,
        viteConfigPresent: ctx.viteConfigPresent,
        serverVersion: ctx.serverVersion,
        mcpProtocolVersion: MCP_PROTOCOL_VERSION,
      }
      return {
        contents: [
          {
            uri: CONFIG_URI,
            mimeType: 'application/json',
            text: JSON.stringify(cfg, null, 2),
          },
        ],
      }
    }
    throw new Error(`unknown resource uri: ${req.params.uri}`)
  })

  return server
}
