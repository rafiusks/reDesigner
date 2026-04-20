import { crx } from '@crxjs/vite-plugin'
import { defineConfig } from 'vite'
import manifest from './manifest.json' with { type: 'json' }

// CRXJS ~2.4.0 (tilde-patch pin — patch range only). See docs/ext-build-migration.md
// for the tripwire criteria (unresolved P1 >30d or CSP-violation blocking panel load)
// that would trigger migration to WXT or hand-rolled Vite multi-entry.
export default defineConfig({
  // biome-ignore lint/suspicious/noExplicitAny: CRXJS manifest typing lags MV3 additions (key, commands shape).
  plugins: [crx({ manifest: manifest as any })],
})
