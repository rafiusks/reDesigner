/**
 * ConnectionBadge — visual indicator for the panel connection status.
 *
 * Each state has a distinct RING SHAPE (not just color) for accessibility:
 *  off:          empty ring
 *  connecting:   dashed ring
 *  connected:    filled circle
 *  error:        cross/X
 *  mcp-missing:  half-ring
 *
 * The `title` attribute provides hover labels for low-vision / screen-reader users.
 */

import type { JSX } from 'react'

export type ConnectionStatus = 'off' | 'connecting' | 'connected' | 'error' | 'mcp-missing'

export interface ConnectionBadgeProps {
  status: ConnectionStatus | string
}

interface ShapeConfig {
  shape: string
  title: string
  color: string
  svgPath: JSX.Element
}

const SIZE = 20

function shapes(): Record<string, ShapeConfig> {
  return {
    off: {
      shape: 'empty-ring',
      title: 'Disconnected',
      color: '#888',
      svgPath: (
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={SIZE / 2 - 2}
          fill="none"
          stroke="#888"
          strokeWidth={2}
        />
      ),
    },
    connecting: {
      shape: 'dashed-ring',
      title: 'Connecting…',
      color: '#f5a623',
      svgPath: (
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={SIZE / 2 - 2}
          fill="none"
          stroke="#f5a623"
          strokeWidth={2}
          strokeDasharray="4 2"
        />
      ),
    },
    connected: {
      shape: 'filled-circle',
      title: 'Connected',
      color: '#4caf50',
      svgPath: <circle cx={SIZE / 2} cy={SIZE / 2} r={SIZE / 2 - 2} fill="#4caf50" />,
    },
    error: {
      shape: 'cross',
      title: 'Connection error',
      color: '#e53935',
      svgPath: (
        <>
          <line
            x1={4}
            y1={4}
            x2={SIZE - 4}
            y2={SIZE - 4}
            stroke="#e53935"
            strokeWidth={2.5}
            strokeLinecap="round"
          />
          <line
            x1={SIZE - 4}
            y1={4}
            x2={4}
            y2={SIZE - 4}
            stroke="#e53935"
            strokeWidth={2.5}
            strokeLinecap="round"
          />
        </>
      ),
    },
    'mcp-missing': {
      shape: 'half-ring',
      title: 'MCP shim not configured',
      color: '#9c27b0',
      svgPath: (
        <path
          d={`M ${SIZE / 2} 2 A ${SIZE / 2 - 2} ${SIZE / 2 - 2} 0 1 1 ${SIZE / 2} ${SIZE - 2}`}
          fill="none"
          stroke="#9c27b0"
          strokeWidth={2}
          strokeLinecap="round"
        />
      ),
    },
  }
}

const FALLBACK_CONFIG: ShapeConfig = {
  shape: 'empty-ring',
  title: 'Unknown',
  color: '#888',
  svgPath: (
    <circle
      cx={SIZE / 2}
      cy={SIZE / 2}
      r={SIZE / 2 - 2}
      fill="none"
      stroke="#888"
      strokeWidth={2}
    />
  ),
}

export function ConnectionBadge(props: ConnectionBadgeProps): JSX.Element {
  const config = shapes()[props.status] ?? FALLBACK_CONFIG

  return (
    <span
      data-testid="connection-badge"
      data-status={props.status}
      data-shape={config.shape}
      title={config.title}
      aria-label={config.title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: SIZE,
        height: SIZE,
      }}
    >
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true" role="img">
        {config.svgPath}
      </svg>
    </span>
  )
}
