import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/schemas/index.ts', 'src/types/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  outDir: 'dist',
  target: 'node22',
  sourcemap: true,
})
