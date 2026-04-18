export type JsxRuntime = 'automatic' | 'classic'

export interface RuntimeDetectInput {
  esbuild?: { jsx?: 'automatic' | 'transform' | 'preserve' | string }
  plugins?: Array<{ name?: string }>
  tsconfig?: { compilerOptions?: { jsx?: string } }
}

export interface RuntimeDetectResult {
  runtime: JsxRuntime
  source: 'esbuild' | 'plugin-react' | 'default'
  tsconfigHint?: JsxRuntime
}

export function detectJsxRuntime(input: RuntimeDetectInput): RuntimeDetectResult {
  if (input.esbuild?.jsx === 'automatic') return { runtime: 'automatic', source: 'esbuild' }
  if (input.esbuild?.jsx === 'transform') return { runtime: 'classic', source: 'esbuild' }

  const hasPluginReact = (input.plugins ?? []).some((p) => p?.name?.startsWith('vite:react'))
  if (hasPluginReact) {
    return { runtime: 'automatic', source: 'plugin-react' }
  }

  const tsconfigJsx = input.tsconfig?.compilerOptions?.jsx
  const tsconfigHint: JsxRuntime | undefined =
    tsconfigJsx === 'react'
      ? 'classic'
      : tsconfigJsx?.startsWith('react-')
        ? 'automatic'
        : undefined

  return { runtime: 'automatic', source: 'default', ...(tsconfigHint ? { tsconfigHint } : {}) }
}
