import { describe, expect, it } from 'vitest'
import { WRAPPER_NAMES, isReactWrapperName } from '../../src/core/wrapperComponents'

describe('isReactWrapperName', () => {
  it.each([
    'Fragment',
    'Suspense',
    'Profiler',
    'StrictMode',
    'Activity',
    'ViewTransition',
    'Offscreen',
    'ErrorBoundary',
  ])('identifies %s as wrapper', (name) => {
    expect(isReactWrapperName(name)).toBe(true)
  })

  it('does not flag arbitrary user names', () => {
    expect(isReactWrapperName('Button')).toBe(false)
    expect(isReactWrapperName('MyErrorHandler')).toBe(false)
  })

  it('flags React.Fragment (dotted form)', () => {
    expect(isReactWrapperName('React.Fragment')).toBe(true)
  })

  it('exports WRAPPER_NAMES for visitor use', () => {
    expect(WRAPPER_NAMES).toContain('Suspense')
  })
})
