/**
 * RecentList — renders up to 10 recent selections.
 */

import type { ComponentHandle } from '@redesigner/core/types'
import type { JSX } from 'react'

export interface RecentListProps {
  recent: readonly ComponentHandle[]
}

export function RecentList(props: RecentListProps): JSX.Element {
  const items = props.recent.slice(0, 10)

  return (
    <div data-testid="recent-list" data-count={props.recent.length} style={{ marginTop: 8 }}>
      {items.length === 0 ? (
        <div style={{ fontSize: 11, color: '#aaa', padding: '4px 8px' }}>No recent selections</div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {items.map((handle) => (
            <li
              key={handle.id}
              style={{
                padding: '4px 8px',
                fontSize: 12,
                borderBottom: '1px solid #f0f0f0',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span style={{ fontWeight: 500 }}>{handle.componentName}</span>
              <span
                style={{
                  color: '#aaa',
                  fontSize: 10,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {handle.filePath}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
