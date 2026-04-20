/**
 * SelectionCard — displays the currently selected component.
 *
 * - Pip: "Claude Code can see this" (always when selection exists)
 * - Adaptive chip:
 *   - mcpWired: Try: "what's my current selection?"  (copy-to-clipboard)
 *   - !mcpWired: Set up the MCP shim (shows snippet)
 * - Copy handle: filePath:line:col; Shift-click → full JSON
 * - Show pickable elements toggle
 */

import type { ComponentHandle } from '@redesigner/core/types'
import type { JSX } from 'react'

export interface SelectionCardProps {
  selection: ComponentHandle | null
  mcpWired: boolean
}

export function SelectionCard(props: SelectionCardProps): JSX.Element | null {
  const { selection, mcpWired } = props

  if (!selection) return null

  const handleCopyHandle = async (e: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    if (e.shiftKey) {
      await navigator.clipboard.writeText(JSON.stringify(selection))
    } else {
      const text = `${selection.filePath}:${selection.lineRange[0]}:1`
      await navigator.clipboard.writeText(text)
    }
  }

  const handleShowPickable = (): void => {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({ type: 'show-pickable-elements' })
    }
  }

  const mcpSnippet = 'claude mcp add --transport stdio redesigner -- <path>/mcp.sh'

  return (
    <div
      data-testid="selection-card"
      style={{ padding: '8px', border: '1px solid #ddd', borderRadius: 4 }}
    >
      {/* Pip */}
      <div data-testid="selection-pip" style={{ fontSize: 11, color: '#4caf50', marginBottom: 4 }}>
        Claude Code can see this
      </div>

      {/* Component name */}
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{selection.componentName}</div>
      <div style={{ fontSize: 11, color: '#666', marginBottom: 8 }}>
        {selection.filePath}:{selection.lineRange[0]}
      </div>

      {/* Adaptive chip */}
      {mcpWired ? (
        <div data-testid="mcp-chip-wired" style={{ marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontStyle: 'italic', color: '#555' }}>
            Try: &ldquo;what&apos;s my current selection?&rdquo;
          </span>
          <button
            type="button"
            data-testid="copy-prompt"
            onClick={() => navigator.clipboard.writeText("what's my current selection?")}
            style={{ marginLeft: 6, fontSize: 11, cursor: 'pointer' }}
          >
            Copy
          </button>
        </div>
      ) : (
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
            <div>{mcpSnippet}</div>
            <div style={{ marginTop: 4, color: '#555', fontFamily: 'inherit' }}>
              Then restart Claude Code.
            </div>
          </div>
        </div>
      )}

      {/* Actions row */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          data-testid="copy-handle"
          onClick={handleCopyHandle}
          title="Shift-click for full JSON"
          style={{ fontSize: 11, cursor: 'pointer' }}
        >
          Copy handle
        </button>

        <button
          type="button"
          data-testid="show-pickable"
          onClick={handleShowPickable}
          style={{ fontSize: 11, cursor: 'pointer' }}
        >
          Show pickable elements
        </button>
      </div>
    </div>
  )
}
