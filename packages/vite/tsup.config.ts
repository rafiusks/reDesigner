import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/reader.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'node20',
  // @redesigner/daemon is an optional runtime peer; vite/@vitejs/plugin-react are
  // peer dependencies supplied by the host project — never bundle any of them.
  external: ['@redesigner/daemon', 'vite', '@vitejs/plugin-react'],
})
