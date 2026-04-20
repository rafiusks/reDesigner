import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // Global hooks no-op unless PW_FULL_HARNESS=1 — safe to always register.
  globalSetup: './test/e2e/globalSetup.ts',
  globalTeardown: './test/e2e/globalTeardown.ts',
  use: {
    trace: 'on-first-retry',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: '@smoke',
      testMatch: /smoke\/.*\.spec\.ts/,
      retries: process.env.CI ? 2 : 0,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: '@nightly',
      testMatch: /nightly\/.*\.spec\.ts/,
      retries: 0,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
