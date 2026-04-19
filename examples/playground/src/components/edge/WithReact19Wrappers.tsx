import { Activity, type ReactNode } from 'react'

// ViewTransition is canary-only in react@19.2; stub a pass-through so the
// playground actually renders. The babel wrapper-skip list matches on JSX
// name, so this still exercises the same invariant.
function ViewTransition({ children }: { name?: string; children?: ReactNode }) {
  return <>{children}</>
}

export function WithReact19Wrappers() {
  return (
    <Activity mode="visible">
      <ViewTransition name="fade">
        <div>react-19-wrappers</div>
      </ViewTransition>
    </Activity>
  )
}
