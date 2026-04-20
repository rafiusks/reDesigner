/**
 * App — side-panel root component. Subscribes to the `usePanelPort` external
 * store keyed by (windowId, tabId) and composes the visual subtree.
 *
 * This file is deliberately thin: per Task 29 the visual components are stubs
 * that Task 30 will flesh out. The contract we lock in here is:
 *  - `data-testid="panel-root"` on the outermost element, with `data-status`
 *    reflecting the current PanelStatus. Tests and styling key off these.
 *  - `data-resync="true"` during the dimmed transient so CSS can fade without
 *    re-triggering a skeleton — React keeps the tree mounted.
 *  - Before a snapshot has been pushed (`version === 0` or status ===
 *    `'hydrating'`), a skeleton placeholder renders.
 *
 * Critical: no `zod` import, direct or transitive. The panel bundle stays
 * schema-free; the SW has already validated everything that reaches us.
 */

import type { JSX } from 'react'
import { ConnectionBadge } from './ConnectionBadge.js'
import { Debug } from './Debug.js'
import { EmptyStates } from './EmptyStates.js'
import { ErrorBanners } from './ErrorBanners.js'
import { PickerToggle } from './PickerToggle.js'
import { RecentList } from './RecentList.js'
import { SelectionCard } from './SelectionCard.js'
import { ShortcutsFooter } from './ShortcutsFooter.js'
import { Welcome } from './Welcome.js'
import type { ConnectFn } from './hooks/usePanelPort.js'
import { usePanelPort } from './hooks/usePanelPort.js'

export interface AppProps {
  windowId: number
  tabId: number
  /** Test seam — defaults to chrome.runtime.connect({name:'panel'}). */
  connect?: ConnectFn
}

export function App(props: AppProps): JSX.Element {
  const snapshot = usePanelPort({
    windowId: props.windowId,
    tabId: props.tabId,
    ...(props.connect ? { connect: props.connect } : {}),
  })

  const isSkeleton = snapshot.status === 'hydrating' && snapshot.version === 0
  const isResync = snapshot.status === 'resync'

  return (
    <div
      data-testid="panel-root"
      data-status={snapshot.status}
      data-resync={isResync ? 'true' : 'false'}
    >
      <ConnectionBadge status={snapshot.status} />
      {isSkeleton ? (
        <div data-testid="panel-skeleton">loading…</div>
      ) : (
        <>
          <Welcome />
          <PickerToggle armed={snapshot.pickerArmed} />
          {snapshot.status === 'mcp-missing' ? (
            <EmptyStates reason="mcp-missing" />
          ) : snapshot.status === 'disconnected' ? (
            <EmptyStates reason="disconnected" />
          ) : snapshot.selection ? (
            <SelectionCard selection={snapshot.selection} mcpWired={true} />
          ) : (
            <EmptyStates reason="no-selection" />
          )}
          <RecentList recent={snapshot.recent} />
          <ErrorBanners
            reconnecting={snapshot.status === 'resync'}
            onReloadTab={() => chrome.tabs.reload(snapshot.tabId)}
          />
          <ShortcutsFooter />
          <Debug tabId={snapshot.tabId} windowId={snapshot.windowId} version={snapshot.version} />
        </>
      )}
    </div>
  )
}
