import * as parser from '@babel/parser'
import traverse, { type NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import { describe, expect, it } from 'vitest'
import { resolveEnclosingComponent } from '../../src/babel/resolveEnclosingComponent'

function findFirstJSX(code: string): NodePath<t.JSXOpeningElement> {
  const ast = parser.parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] })
  let found: NodePath<t.JSXOpeningElement> | null = null
  traverse(ast, {
    JSXOpeningElement(p) {
      if (!found) found = p
    },
  })
  if (!found) throw new Error('no JSX in fixture')
  return found
}

describe('resolveEnclosingComponent', () => {
  it('default export function component', () => {
    const p = findFirstJSX('export default function Button() { return <div /> }')
    expect(resolveEnclosingComponent(p, 'src/Button.tsx')).toEqual({
      componentName: 'Button',
      exportKind: 'default',
      lineRange: [1, 1],
    })
  })

  it('named export function component', () => {
    const p = findFirstJSX('export function Button() { return <div /> }')
    expect(resolveEnclosingComponent(p, 'src/Button.tsx')).toEqual({
      componentName: 'Button',
      exportKind: 'named',
      lineRange: [1, 1],
    })
  })

  it('arrow const component', () => {
    const p = findFirstJSX('export const Button = () => <div />')
    expect(resolveEnclosingComponent(p, 'src/Button.tsx')).toMatchObject({
      componentName: 'Button',
      exportKind: 'named',
    })
  })

  it('memo-wrapped', () => {
    const p = findFirstJSX(
      `import {memo} from 'react'\nconst Button = memo(() => <div />)\nexport default Button`,
    )
    expect(resolveEnclosingComponent(p, 'src/Button.tsx')).toMatchObject({
      componentName: 'Button',
    })
  })

  it('legacy forwardRef-wrapped', () => {
    const p = findFirstJSX(
      `import {forwardRef} from 'react'\nconst Input = forwardRef((p, ref) => <input ref={ref} />)\nexport default Input`,
    )
    expect(resolveEnclosingComponent(p, 'src/Input.tsx')).toMatchObject({ componentName: 'Input' })
  })

  it('ref-as-prop (React 19 idiom)', () => {
    const p = findFirstJSX('export function Input({ref}) { return <input ref={ref} /> }')
    expect(resolveEnclosingComponent(p, 'src/Input.tsx')).toMatchObject({ componentName: 'Input' })
  })

  it('anonymous default export → PascalCase filename', () => {
    const p = findFirstJSX('export default () => <div />')
    expect(resolveEnclosingComponent(p, 'src/my-widget.tsx')).toMatchObject({
      componentName: 'MyWidget',
    })
  })

  it('JSX in callback → attribute to outer component', () => {
    const p = findFirstJSX('export function List() { return [1,2].map(n => <li>{n}</li>) }')
    // The FIRST jsx opening is <li>; it should be attributed to List.
    expect(resolveEnclosingComponent(p, 'src/List.tsx')).toMatchObject({ componentName: 'List' })
  })

  it('JSX at module scope → (module) synthetic', () => {
    const p = findFirstJSX(
      `import {createRoot} from 'react-dom/client'\ncreateRoot(x).render(<App />)`,
    )
    expect(resolveEnclosingComponent(p, 'src/main.tsx')).toMatchObject({
      componentName: '(module)',
    })
  })

  it('class component', () => {
    const p = findFirstJSX(
      'export class Modal extends React.Component { render() { return <div /> } }',
    )
    expect(resolveEnclosingComponent(p, 'src/Modal.tsx')).toMatchObject({ componentName: 'Modal' })
  })

  it('third-party HOC → assignment-target name (NOT unwrapped)', () => {
    const p = findFirstJSX('const StyledButton = styled(Button)\nconst X = () => <StyledButton />')
    expect(resolveEnclosingComponent(p, 'src/x.tsx')).toMatchObject({ componentName: 'X' })
  })
})
