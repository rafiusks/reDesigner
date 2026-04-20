import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Parallelism + daemon-real tests have dedicated configs (forks pool, isolation).
    // Exclude them here so they do not double-run (and parallelism.test.ts would
    // flake under the default threads pool against a shared .redesigner/ dir).
    exclude: ['test/integration/parallelism.test.ts', 'test/integration/daemon-real.test.ts'],
  },
})
