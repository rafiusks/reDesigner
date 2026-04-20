/**
 * backfill — on-install content script injection for existing localhost tabs.
 *
 * Gated on permissions.contains({origins:['http://localhost/*']}):
 *   - Granted: query localhost tabs + executeScript on each.
 *   - Denied: call onGrantAccess() for panel toast.
 */

export interface BackfillController {
  runOnInstalled(): Promise<void>
}

export function createBackfillController(opts?: {
  chromePermissions?: typeof chrome.permissions
  chromeScripting?: typeof chrome.scripting
  chromeTabs?: typeof chrome.tabs
  onGrantAccess?: () => void
}): BackfillController {
  const chromePermissions = opts?.chromePermissions ?? chrome.permissions
  const chromeScripting = opts?.chromeScripting ?? chrome.scripting
  const chromeTabs = opts?.chromeTabs ?? chrome.tabs
  const onGrantAccess = opts?.onGrantAccess

  async function runOnInstalled(): Promise<void> {
    const granted = await chromePermissions.contains({ origins: ['http://localhost/*'] })

    if (!granted) {
      onGrantAccess?.()
      return
    }

    const tabs = await chromeTabs.query({
      url: ['http://localhost/*', 'http://127.0.0.1/*'],
    })

    await Promise.all(
      tabs
        .filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id !== undefined)
        .map((tab) =>
          chromeScripting
            .executeScript({
              target: { tabId: tab.id },
              files: ['src/content/index.ts'],
            })
            .catch(() => {
              // Ignore per-tab injection errors — tab may have navigated away.
            }),
        ),
    )
  }

  return { runOnInstalled }
}
