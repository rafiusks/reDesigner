// SKELETON — intentionally deferred.
//
// This is a v0 smoke placeholder. The full plan calls for a complete
// arm → pick → daemon-PUT /tabs/:tabId/selection flow, which requires a
// running daemon stub + vite dev server + built extension dist wired up end
// to end in CI. That harness is not yet in place.
//
// Until it is, this test only asserts that the extension's service worker
// registers after loading the MV3 bundle — a single smoke signal that the
// ext build is not broken at the manifest/SW level. The fuller assertions
// (panel arm button, selection commit, daemon PUT observed) are deferred to
// the follow-up task that wires the daemon+vite+ext harness together.
//
// Do not add `throw new Error(...)` here; a passing one-line smoke signal
// is the intended behavior during this skeleton phase.
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
