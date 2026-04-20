<!-- human -->
# Extension Build Migration Runbook

This document records why reDesigner's Chrome extension uses CRXJS today, the named tripwire that would trigger migration, and step-by-step migration outlines for the two candidate replacements (WXT and hand-rolled Vite multi-entry). It also covers the procedure for rotating the MV3 `key` field if the dev public key in `manifest.json` is ever leaked or needs to change.

## Why CRXJS now

- Active maintainer team back on the project; patch releases flowing on the 2.x line.
- Best-in-class DX for Vite + MV3: manifest-driven entry discovery, HMR across service worker / content scripts / side panel without manual multi-config juggling.
- Native handling of MV3 ESM service worker wrapping, content-script chunk splitting, and cross-context asset URL rewriting.
- We can ride CRXJS upgrades via a tilde pin without pulling in breaking plugin changes on accident.

## Version pin policy

`packages/ext/package.json` pins `@crxjs/vite-plugin` to `~2.y.z` (tilde = patch range only). This means:

- Patch updates (`2.4.0 → 2.4.1`) are accepted on `pnpm install`.
- Minor updates (`2.4.x → 2.5.0`) require an explicit bump + a local smoke build before landing.
- Major updates (`2.x → 3.x`) require an RFC in `docs/superpowers/` and a migration plan equivalent to this document.

## Tripwire — when to migrate

Migration is triggered by EITHER of the following:

1. An unresolved CRXJS P1-labelled bug remains open in the upstream issue tracker for more than **30 consecutive days** with no maintainer response or workaround.
2. A CSP-violation regression in CRXJS output blocks panel load for any supported Chromium channel (stable, beta, dev) on the matrix we test, with no known workaround we can ship.

Either condition opens an RFC that MUST choose between the two migration paths below.

## Migration path A — WXT

WXT is a framework-for-web-extensions: opinionated structure, its own `wxt dev`/`wxt build` CLI, generates the manifest from TypeScript.

High-level steps:

1. Install: `pnpm --filter @redesigner/ext add -D wxt` and remove `@crxjs/vite-plugin`.
2. Create `packages/ext/wxt.config.ts` — port manifest fields (`minimum_chrome_version`, `key`, `commands`, `host_permissions`, `content_scripts`, `permissions`, `side_panel`, `background`) into WXT's config schema.
3. Move entry files to WXT's conventional layout:
   - `entrypoints/background.ts` ← `src/sw/index.ts`
   - `entrypoints/content.ts` ← `src/content/index.ts` (with `defineContentScript({ matches, runAt: 'document_end' })`)
   - `entrypoints/content-bootstrap.ts` ← `src/content/bootstrap.ts` (with `defineContentScript({ matches, runAt: 'document_start' })`)
   - `entrypoints/sidepanel/index.html` + `main.tsx` ← `src/panel/**`
4. Re-point `package.json` scripts: `dev` → `wxt`, `build` → `wxt build`, drop `vite.config.ts`.
5. Re-run the Task 15 manifest-shape test against the WXT-emitted `dist/chrome-mv3/manifest.json` (update path; the invariants do not change).
6. Re-run the full `packages/ext` test suite (unit + integration + picker + contract + e2e-smoke).
7. Verify the `key` field survives round-trip (WXT supports passthrough via `manifest: { key: '...' }` in `wxt.config.ts`).
8. Smoke-load unpacked build in Chrome; confirm the extension ID is unchanged.
9. Delete `@crxjs/vite-plugin` + `vite.config.ts` + `docs/ext-build-migration.md` tripwire references; keep this file as the migration record.

## Migration path B — hand-rolled Vite multi-entry

Keep Vite; drop the MV3-aware plugin. Write manifest and HMR glue ourselves.

High-level steps:

1. Remove `@crxjs/vite-plugin`.
2. Restructure `vite.config.ts` with `build.rollupOptions.input` listing every MV3 entry (`sw`, `content/index`, `content/bootstrap`, `panel/index.html`).
3. Add a small `scripts/build-manifest.ts` post-build step that reads `manifest.json`, rewrites `background.service_worker`, `content_scripts[*].js`, `action.default_icon`, and `side_panel.default_path` to the hashed emitted filenames from `vite.manifest.json`, and writes to `dist/manifest.json`.
4. Split background into its own Vite build (MV3 requires a single bundled file; esbuild inline + no code-splitting for that entry). Config: `build.rollupOptions.output.inlineDynamicImports: true` on the SW build only.
5. Re-implement HMR manually: a dev-only WS client in the panel that triggers `chrome.runtime.reload()` on file change; content scripts accept source-of-truth loss and reload the tab.
6. Re-run the Task 15 manifest-shape test against the post-build `dist/manifest.json`.
7. Re-run the full extension test suite.
8. Verify MV3 invariants: no dynamic `import()` reachable from SW, no eval in content scripts, CSP `script-src 'self'` compliance.
9. Document the build-manifest rewriter in a new `docs/ext-vite-multi-entry.md`.

Choose path A if we want ergonomics back quickly and accept a framework dependency. Choose path B if we need total control of the build graph (e.g., a specific CSP or chunk topology CRXJS cannot express).

## `key` field rotation

The `key` field in `manifest.json` is a base64 SPKI RSA-2048 public key. Chromium hashes it to compute the unpacked extension ID, so pinning a key keeps the dev ID stable across reloads — this matters because `externally_connectable` hosts and dev bookmarks index by ID.

The current key is a **throwaway dev key**. The matching private key is intentionally not checked in and is not used to sign anything (Web Store signing uses a different, Google-held key). Leaking the `key` value exposes the public half only; nothing is compromised. Rotation is nonetheless documented for hygiene.

Procedure:

1. Generate a new key pair (never reuse old material):
   ```sh
   node --input-type=module -e "import { generateKeyPairSync } from 'node:crypto'; const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 }); console.log(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'))"
   ```
2. Replace the `key` string in `packages/ext/manifest.json` with the emitted base64 value.
3. Note that the **extension ID changes** — any developer with the old unpacked extension loaded will see a different ID on next reload. Anyone relying on the old ID (e.g., hand-edited allowlists, bookmarks, daemon `externally_connectable` entries once Web Store bindings ship) must update.
4. Post the new ID to the team channel + bump `brief.md` / internal docs if they reference it.
5. The private key of the old pair does not need to be destroyed (it was never exported or persisted) but the base64 `key` value should be considered rotated and old copies in branches rebased forward.

## Non-goals for this runbook

- Web Store publishing key management (handled by Google on upload; unrelated to the manifest `key` field).
- Channel (stable/beta/dev) migration policy — separate document.
- Cross-browser (Firefox/Safari) strategies — out of scope for v0.
