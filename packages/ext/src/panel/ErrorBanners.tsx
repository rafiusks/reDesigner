/**
 * ErrorBanners — placeholder. Task 30 replaces with real visual component.
 */

import type { JSX } from 'react'

export interface ErrorBannersProps {
  error: string | null
}

export function ErrorBanners(props: ErrorBannersProps): JSX.Element | null {
  if (!props.error) return null
  return (
    <div data-testid="error-banner" role="alert">
      {props.error}
    </div>
  )
}
