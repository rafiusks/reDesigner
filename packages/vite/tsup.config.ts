import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/reader.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  // node22: preserves the `with { type: 'json' }` import attribute on
  // vite/package.json (Node 22+ requires it, and older esbuild targets
  // silently strip it, producing ERR_IMPORT_ATTRIBUTE_MISSING at runtime).
  target: 'node22',
  // @redesigner/daemon is an optional runtime peer; vite/@vitejs/plugin-react are
  // peer dependencies supplied by the host project — never bundle any of them.
  external: ['@redesigner/daemon', 'vite', '@vitejs/plugin-react'],
})
