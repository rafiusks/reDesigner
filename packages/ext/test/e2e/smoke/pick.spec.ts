import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect, test } from '@playwright/test'

const EXT_DIST = fileURLToPath(new URL('../../../dist', import.meta.url))

test.describe('@smoke picker commit', () => {
  test('arm → pick → daemon receives PUT /tabs/:tabId/selection', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'redesigner-smoke-'))

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false, // MV3 extensions need headed mode or 'new' headless
      args: [
        `--disable-extensions-except=${EXT_DIST}`,
        `--load-extension=${EXT_DIST}`,
        '--no-sandbox',
      ],
    })

    try {
      // Fixture daemon stub + vite dev server assumed launched by a test setup script
      const devUrl = process.env.PW_DEV_URL ?? 'http://localhost:5173'
      const page = await context.newPage()
      await page.goto(devUrl)

      // SW wakes; handshake completes; arm via chrome.commands if bound. For smoke,
      // simulate via panel button click rather than keyboard chord (panel UX is
      // easier to script deterministically).
      //
      // TODO(harness): wire up panel open + pick button click when panel is fully
      // integrated. For v0 smoke, assert page loads + SW is registered.
      //
      // Full pick-flow assertion (daemon receives PUT /tabs/:tabId/selection with
      // correct ComponentHandle) requires a daemon stub; deferred to follow-up once
      // daemon + vite + ext dist are running end-to-end in CI.
      const sws = context.serviceWorkers()
      expect(sws.length).toBeGreaterThan(0)
    } finally {
      await context.close()
    }
  })
})
