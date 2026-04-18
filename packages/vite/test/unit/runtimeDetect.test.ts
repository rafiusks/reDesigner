import { describe, expect, it } from 'vitest'
import { detectJsxRuntime } from '../../src/integration/runtimeDetect'

describe('detectJsxRuntime', () => {
  it('esbuild.jsx automatic → automatic + source=esbuild', () => {
    expect(detectJsxRuntime({ esbuild: { jsx: 'automatic' } })).toEqual({
      runtime: 'automatic',
      source: 'esbuild',
    })
  })
  it('esbuild.jsx transform (classic) → classic + source=esbuild', () => {
    expect(detectJsxRuntime({ esbuild: { jsx: 'transform' } })).toEqual({
      runtime: 'classic',
      source: 'esbuild',
    })
  })
  it('no esbuild, plugin-react present → automatic + source=plugin-react', () => {
    expect(detectJsxRuntime({ plugins: [{ name: 'vite:react-babel' }] })).toEqual({
      runtime: 'automatic',
      source: 'plugin-react',
    })
  })
  it('no authoritative source, tsconfig jsx=react (classic) → automatic + source=default + tsconfigHint=classic', () => {
    expect(detectJsxRuntime({ tsconfig: { compilerOptions: { jsx: 'react' } } })).toEqual({
      runtime: 'automatic',
      source: 'default',
      tsconfigHint: 'classic',
    })
  })
  it('fully unconfigured → automatic + source=default', () => {
    expect(detectJsxRuntime({})).toMatchObject({ runtime: 'automatic', source: 'default' })
  })
})
