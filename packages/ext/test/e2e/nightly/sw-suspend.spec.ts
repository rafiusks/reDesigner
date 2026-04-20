import { test } from '@playwright/test'
import { requireFullHarness } from './_harness'

test('@nightly SW-suspend + __bootEpoch increment', async () => {
  if (!requireFullHarness()) return

  // TODO(harness): launchPersistentContext(--load-extension=EXT_DIST) → attach
  // CDP to SW target → capture __bootEpoch → chrome.debugger.ServiceWorker
  // .stopAllWorkers (retry-attach loop; waitForEvent('serviceworker') fallback)
  // → assert __bootEpoch incremented by exactly 1.
})
