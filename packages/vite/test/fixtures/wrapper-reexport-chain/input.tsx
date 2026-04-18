import { Suspense } from './my-shim'

export function X() {
  return (
    <Suspense>
      <span />
    </Suspense>
  )
}
