import { defineConfig } from 'vitest/config'

// Runs daemon-real integration test separately — it needs a real sub-process spawn.
export default defineConfig({
  test: {
    include: ['test/integration/daemon-real.test.ts'],
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    passWithNoTests: true,
  },
})
