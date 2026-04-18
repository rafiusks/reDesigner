import { StrictMode, Suspense } from 'react'

export function X() {
  return (
    <Suspense>
      <StrictMode>
        <span />
      </StrictMode>
    </Suspense>
  )
}
