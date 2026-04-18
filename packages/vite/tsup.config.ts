import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/reader.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'node20',
  // @redesigner/daemon is an optional runtime peer — not bundled
  external: ['@redesigner/daemon'],
})
