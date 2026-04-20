import { test } from '@playwright/test'
import { requireFullHarness } from './_harness'

test('@nightly Welcome polling transitions to Detected', async () => {
  if (!requireFullHarness()) return

  // TODO(harness): install ext BEFORE starting vite dev; seed storage with
  // welcomePollMs=500; open welcome tab (expect waiting); start vite; wait
  // up to 3× welcomePollMs for auto-transition to Detected without reload.
})
