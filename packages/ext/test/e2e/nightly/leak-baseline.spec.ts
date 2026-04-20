import { test } from '@playwright/test'
import { requireFullHarness } from './_harness'

test('@nightly heap baseline after CDP GC', async () => {
  if (!requireFullHarness()) return

  // TODO(harness): attach CDP to SW; HeapProfiler.collectGarbage; read
  // Runtime.getHeapUsage + chrome.storage.session.getBytesInUse(); compare
  // vs packages/ext/leak-baseline.json (fail if > baseline × 1.2; first-run
  // writes baseline).
})
