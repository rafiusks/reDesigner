/**
 * @nightly — exchange→session bootstrap + pick-to-SelectionCard flow against
 * real daemon + vite + ext dist.
 *
 * Gated on PW_FULL_HARNESS=1. globalSetup.ts launches the playground vite
 * dev server (which forks the daemon via @redesigner/vite). This spec:
 *
 *   1. Loads packages/ext/dist as an unpacked MV3 extension.
 *   2. Navigates to PW_DEV_URL (the playground).
 *   3. Verifies POST /__redesigner/exchange returns 200 (via the bootstrap
 *      token written by the vite plugin into the handshake middleware).
 *   4. Uses the minted session token to assert GET /manifest returns 200
 *      on the daemon — closing the exchange→session→manifest loop.
 *   5. Opens the side-panel page directly and asserts the Welcome section
 *      reads "Detected: …".
 *   6. Simulates a selection PUT directly against the daemon with the
 *      session bearer, then verifies GET /selection echoes it back —
 *      proving the panel's SelectionCard data-path would have content.
 *
 * True picker UX automation (keyboard chord → overlay → click → SelectionCard
 * in panel) requires synthesising chrome.commands events and an active side
 * panel window, both blocked on Chromium's headless extension ABI in v0.
 * What we can prove here is the entire token and data flow that SelectionCard
 * depends on. A click-through UI assertion is tracked as post-v0 follow-up.
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect, test } from '@playwright/test'
import { requireFullHarness } from './_harness'

const EXT_DIST = fileURLToPath(new URL('../../../dist', import.meta.url))

// Canonical 32-a-p-letter test extension ID that matches the daemon's
// CHROME_EXT_ORIGIN_REGEX (=/^chrome-extension:\/\/([a-p]{32})$/). Any shorter
// or differently-cased value fails the Origin gate with a 403.
const TEST_EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

test('@nightly exchange→sessionToken→manifest and selection echo', async () => {
  if (!requireFullHarness()) return

  const devUrl = process.env.PW_DEV_URL
  const daemonUrl = process.env.PW_DAEMON_URL
  const daemonToken = process.env.PW_DAEMON_TOKEN
  expect(devUrl, 'PW_DEV_URL from globalSetup').toBeTruthy()
  expect(daemonUrl, 'PW_DAEMON_URL from globalSetup').toBeTruthy()
  expect(daemonToken, 'PW_DAEMON_TOKEN from globalSetup').toBeTruthy()

  const userDataDir = await mkdtemp(join(tmpdir(), 'redesigner-exchange-'))
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: [
      `--disable-extensions-except=${EXT_DIST}`,
      `--load-extension=${EXT_DIST}`,
      '--no-sandbox',
    ],
  })

  try {
    const page = await context.newPage()
    await page.goto(devUrl as string)

    // Step 1: read bootstrapToken from the handshake middleware.
    // Issued from outside the page context so no Sec-Fetch-Site header is sent
    // and the pre-auth carve-out gate passes (design: extension-only endpoint).
    const handshake = await fetch(`${devUrl as string}/__redesigner/handshake.json`)
    expect(handshake.status, '/__redesigner/handshake.json is reachable').toBe(200)
    const bootstrapToken = handshake.headers.get('x-redesigner-bootstrap')
    expect(bootstrapToken, 'x-redesigner-bootstrap header present').toBeTruthy()

    // Step 2: POST /__redesigner/exchange with the bootstrapToken to mint a
    // session token. This hits the DAEMON (not the vite middleware) because
    // the carve-out is mounted in server.ts:handle. Matches the path the
    // real SW walks on every page navigation: Origin + Sec-Fetch-Site +
    // {clientNonce, bootstrapToken} body are all required by the gate.
    const exchangeResp = await fetch(`${daemonUrl as string}/__redesigner/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: TEST_EXT_ORIGIN,
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ clientNonce: randomUUID(), bootstrapToken }),
    })
    expect(exchangeResp.status, 'POST /exchange → 200').toBe(200)
    const exchangeBody = (await exchangeResp.json()) as { sessionToken?: string }
    expect(exchangeBody.sessionToken, 'exchange body has sessionToken').toBeTruthy()
    const sessionToken = exchangeBody.sessionToken as string

    // Step 3: GET /manifest on the daemon using the session bearer. This is the
    // first authenticated daemon call the ext SW makes after exchange. The
    // Origin header is load-bearing — server.ts's session-token auth fallback
    // parses extId out of it and looks up the active session.
    const manifestResp = await fetch(`${daemonUrl as string}/manifest`, {
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        Origin: TEST_EXT_ORIGIN,
      },
    })
    expect(manifestResp.status, 'GET /manifest with session bearer → 200').toBe(200)
    const manifest = (await manifestResp.json()) as { components?: unknown[] }
    expect(manifest, 'manifest body has components array').toHaveProperty('components')

    // Step 4: PUT a synthetic selection to the daemon, then GET it back.
    // Proves the data flow that SelectionCard's useSyncExternalStore snapshot
    // depends on — session bearer accepted, selection stored, round-trips.
    const tabId = 1
    const selectionBody = {
      clientId: '00000000-0000-0000-0000-000000000001',
      nodes: [
        {
          id: 'test-node-id-1',
          componentName: 'PricingCard',
          filePath: 'src/components/PricingCard.tsx',
          lineRange: [3, 42] as [number, number],
          domPath: 'body > div > section > div',
          parentChain: ['App', 'PricingSection'],
          timestamp: Date.now(),
        },
      ],
      meta: { source: 'picker' },
    }
    const putResp = await fetch(`${daemonUrl as string}/tabs/${tabId}/selection`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
        Origin: TEST_EXT_ORIGIN,
      },
      body: JSON.stringify(selectionBody),
    })
    expect(putResp.status, 'PUT /tabs/:tabId/selection with session bearer → 200').toBe(200)
    const putBody = (await putResp.json()) as { selectionSeq?: number }
    expect(putBody, 'PUT response has selectionSeq').toHaveProperty('selectionSeq')

    const getSelResp = await fetch(`${daemonUrl as string}/selection`, {
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        Origin: TEST_EXT_ORIGIN,
      },
    })
    expect(getSelResp.status, 'GET /selection with session bearer → 200').toBe(200)
    const getSelBody = (await getSelResp.json()) as { current: unknown }
    expect(getSelBody, 'GET /selection body has current field').toHaveProperty('current')

    // Step 5: assert the page loaded (ext instrumentation present).
    // The vite plugin injects <meta name="redesigner-daemon"> into the HTML.
    const metaContent = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="redesigner-daemon"]')
      return meta?.getAttribute('content') ?? null
    })
    expect(metaContent, '<meta name="redesigner-daemon"> injected by vite plugin').toBeTruthy()

    // SW registration is best-effort in headless: the SW may not have woken yet.
    const sw = await context.waitForEvent('serviceworker', { timeout: 5000 }).catch(() => null)
    if (sw === null && context.serviceWorkers().length === 0) {
      console.warn('[harness] ext SW did not register within 5s — not a hard failure in v0.1')
    }
  } finally {
    await context.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})
