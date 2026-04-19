import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/child.ts'],
  format: ['esm'],
  target: 'node22',
  sourcemap: true,
  dts: true,
  clean: true,
  splitting: false,
  external: ['@redesigner/core', 'ws', 'zod'],
})
