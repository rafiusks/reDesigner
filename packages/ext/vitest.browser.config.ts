import { defineConfig } from 'vitest/config'

// Tier-3 picker tests: real DOM via @vitest/browser + bundled Playwright Chromium.
// Kept in a separate config so `pnpm --filter @redesigner/ext test` (unit/integration
// under happy-dom / node) does not pick these up. Enter with:
//   pnpm --filter @redesigner/ext run test:browser
//
// We omit `channel` so Playwright's bundled Chromium is used (pinned via the
// `playwright` devDependency), rather than a system-installed Chrome/Edge.
export default defineConfig({
  test: {
    include: ['test/picker/**/*.spec.ts'],
    browser: {
      enabled: true,
      provider: 'playwright',
      headless: true,
      isolate: true,
      name: 'chromium',
    },
  },
})
