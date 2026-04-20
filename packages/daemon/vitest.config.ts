import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: 'threads',
    poolMatchGlobs: [['test/integration/**', 'forks']],
    poolOptions: {
      forks: { singleFork: true },
    },
  },
})
