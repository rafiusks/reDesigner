import { defineConfig } from 'vitest/config'

// Isolates parallelism-sensitive integration tests:
// - forks pool (not threads) for stronger isolation
// - file parallelism OFF (one test file at a time)
export default defineConfig({
  test: {
    include: ['test/integration/parallelism.test.ts'],
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    passWithNoTests: true,
  },
})
