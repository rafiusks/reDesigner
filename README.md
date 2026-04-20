# redesigner

Dev tool that tags React JSX elements with `data-redesigner-loc` attributes for downstream IDE / extension integration. See `docs/superpowers/specs/` for the design spec.

## Quickstart

```
corepack enable
pnpm install
pnpm -r test
```

## Invariants (read before using the plugin)

- Plugin only runs in `vite dev` (`apply: 'serve'`). `vite build` is a no-op.
- React 19 + automatic JSX runtime only.
- Wrapper components are NOT DOM-tagged: `Fragment`, `Suspense`, `ErrorBoundary` (heuristic), `Profiler`, `StrictMode`, `Activity`, `ViewTransition`, `Offscreen`.
- Module-scope JSX is attributed to a synthetic `(module)` component in the MANIFEST only. The DOM has no `data-redesigner-loc` for module-scope elements — tools should hit-test against `<App>` or deeper.
- The `ErrorBoundary` wrapper heuristic is name-only (no canonical React export exists); renaming a non-wrapper class to `ErrorBoundary` will silently skip attribute injection.
- The wrapper skip list is a closed set; React minor releases may introduce new wrappers — update the list in `core/wrapperComponents.ts` alongside React bumps.
- See `docs/superpowers/specs/2026-04-18-vite-plugin-and-playground-design.md` for the full contract.
