import type { NodePath } from '@babel/traverse'
import * as t from '@babel/types'

export interface EnclosingComponent {
  componentName: string
  exportKind: 'default' | 'named'
  lineRange: [number, number]
}

const MEMO_NAMES = new Set(['memo', 'React.memo'])
const FORWARDREF_NAMES = new Set(['forwardRef', 'React.forwardRef'])

function callName(expr: t.Expression | t.V8IntrinsicIdentifier): string | null {
  if (t.isIdentifier(expr)) return expr.name
  if (t.isMemberExpression(expr) && t.isIdentifier(expr.object) && t.isIdentifier(expr.property)) {
    return `${expr.object.name}.${expr.property.name}`
  }
  return null
}

function unwrap(node: t.Expression): t.Expression {
  if (t.isCallExpression(node)) {
    const name = callName(node.callee as t.Expression)
    if (name && (MEMO_NAMES.has(name) || FORWARDREF_NAMES.has(name)) && node.arguments.length > 0) {
      const first = node.arguments[0]
      if (t.isExpression(first)) return unwrap(first)
    }
  }
  return node
}

function pascalFromFile(relPath: string): string {
  const base = relPath.split('/').pop() ?? 'Unknown'
  const name = base.replace(/\.[jt]sx?$/, '')
  return name
    .split(/[-_\s]+/)
    .map((p) => (p.length > 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join('')
}

function isComponentIdentifier(name: string): boolean {
  return /^[A-Z]/.test(name)
}

export function resolveEnclosingComponent(
  path: NodePath<t.JSXOpeningElement | t.JSXFragment | t.JSXElement>,
  relPath: string,
): EnclosingComponent {
  // Walk up looking for: class component, function declaration (capitalized),
  // variable declarator (capitalized) assigned to a (possibly wrapped) function/arrow.
  let cur: NodePath | null = path.parentPath
  while (cur) {
    const node = cur.node

    // ClassDeclaration
    if (t.isClassDeclaration(node) && node.id && isComponentIdentifier(node.id.name)) {
      const exportKind: 'default' | 'named' = t.isExportDefaultDeclaration(cur.parent)
        ? 'default'
        : 'named'
      return {
        componentName: node.id.name,
        exportKind,
        lineRange: [node.loc?.start.line ?? 0, node.loc?.end.line ?? 0],
      }
    }

    // FunctionDeclaration
    if (t.isFunctionDeclaration(node) && node.id && isComponentIdentifier(node.id.name)) {
      const exportKind: 'default' | 'named' = t.isExportDefaultDeclaration(cur.parent)
        ? 'default'
        : 'named'
      return {
        componentName: node.id.name,
        exportKind,
        lineRange: [node.loc?.start.line ?? 0, node.loc?.end.line ?? 0],
      }
    }

    // VariableDeclarator with arrow/function initializer (may be wrapped in memo/forwardRef)
    if (
      t.isVariableDeclarator(node) &&
      t.isIdentifier(node.id) &&
      isComponentIdentifier(node.id.name) &&
      node.init
    ) {
      const unwrapped = unwrap(node.init)
      if (t.isArrowFunctionExpression(unwrapped) || t.isFunctionExpression(unwrapped)) {
        const declParent = cur.parentPath?.parentPath
        const exportKind: 'default' | 'named' = declParent?.isExportDefaultDeclaration()
          ? 'default'
          : 'named'
        return {
          componentName: node.id.name,
          exportKind,
          lineRange: [node.loc?.start.line ?? 0, node.loc?.end.line ?? 0],
        }
      }
    }

    // export default <expr> where expr is an anonymous arrow/function or memo(...)/forwardRef(...) of anonymous
    if (t.isExportDefaultDeclaration(node)) {
      const decl = node.declaration
      if (t.isArrowFunctionExpression(decl) || t.isFunctionExpression(decl)) {
        const ownName =
          t.isFunctionExpression(decl) && decl.id && isComponentIdentifier(decl.id.name)
            ? decl.id.name
            : null
        return {
          componentName: ownName ?? pascalFromFile(relPath),
          exportKind: 'default',
          lineRange: [node.loc?.start.line ?? 0, node.loc?.end.line ?? 0],
        }
      }
      if (t.isCallExpression(decl)) {
        const unwrapped = unwrap(decl)
        if (t.isArrowFunctionExpression(unwrapped) || t.isFunctionExpression(unwrapped)) {
          const ownName =
            t.isFunctionExpression(unwrapped) &&
            unwrapped.id &&
            isComponentIdentifier(unwrapped.id.name)
              ? unwrapped.id.name
              : null
          return {
            componentName: ownName ?? pascalFromFile(relPath),
            exportKind: 'default',
            lineRange: [node.loc?.start.line ?? 0, node.loc?.end.line ?? 0],
          }
        }
      }
    }

    cur = cur.parentPath
  }

  // Module scope
  return {
    componentName: '(module)',
    exportKind: 'named',
    lineRange: [path.node.loc?.start.line ?? 0, path.node.loc?.end.line ?? 0],
  }
}
