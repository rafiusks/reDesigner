/**
 * MCP setup chip — rendered inside SelectionCard only when mcpWired === false.
 * Lazy-loaded to keep the main panel chunk under the CI size budget; most
 * users never see this state after their first successful setup.
 */

import type { JSX } from 'react'

const MCP_SNIPPET =
  'claude mcp add --transport stdio redesigner -- node <repo>/packages/mcp/dist/cli.js'

export function McpSetupChip(): JSX.Element {
  return (
    <div data-testid="mcp-chip-unwired" style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 12, color: '#1565c0', fontWeight: 500, marginBottom: 6 }}>
        Set up the MCP shim
      </div>

      <div
        data-testid="mcp-snippet"
        style={{
          padding: 8,
          background: '#f5f5f5',
          borderRadius: 4,
          fontSize: 11,
          fontFamily: 'monospace',
        }}
      >
        <div>{MCP_SNIPPET}</div>
        <div style={{ marginTop: 4, color: '#555', fontFamily: 'inherit' }}>
          Then restart Claude Code.
        </div>
      </div>
    </div>
  )
}

export default McpSetupChip
