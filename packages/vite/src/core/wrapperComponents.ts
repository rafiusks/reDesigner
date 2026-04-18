// React built-ins that warn on unknown host-attr props.
// ErrorBoundary is a userland heuristic (no canonical React export) — name-only match.
// Update this list when React minor releases introduce new non-host wrapper components.
export const WRAPPER_NAMES: readonly string[] = Object.freeze([
  'Fragment',
  'React.Fragment',
  'Suspense',
  'Profiler',
  'StrictMode',
  'Activity', // React 19.2
  'ViewTransition', // React 19.2
  'Offscreen', // legacy alias for Activity
  'ErrorBoundary', // userland heuristic
])

const WRAPPER_SET = new Set(WRAPPER_NAMES)

export function isReactWrapperName(name: string): boolean {
  return WRAPPER_SET.has(name)
}
