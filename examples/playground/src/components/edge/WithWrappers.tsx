import { StrictMode, Suspense } from 'react'

export function WithWrappers() {
  return (
    <StrictMode>
      <Suspense fallback={<div>loading</div>}>
        <div>inner</div>
      </Suspense>
    </StrictMode>
  )
}
