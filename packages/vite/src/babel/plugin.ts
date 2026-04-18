import type { PluginObj } from '@babel/core'
import type { NodePath } from '@babel/traverse'
import * as t from '@babel/types'
import { formatLoc } from '../core/locFormat'
import type { PerFileBatch } from '../core/types-internal'
import { isReactWrapperName } from '../core/wrapperComponents'
import { resolveEnclosingComponent } from './resolveEnclosingComponent'

export interface RedesignerBabelPluginOpts {
  relPath: string
  batch: PerFileBatch
  /** Called when a visitor raises — default logs file:line. */
  onWarning?: (msg: string) => void
}

const ATTR_NAME = 'data-redesigner-loc'

function openingElementName(opening: t.JSXOpeningElement): string {
  const name = opening.name
  if (t.isJSXIdentifier(name)) return name.name
  if (t.isJSXMemberExpression(name)) {
    const parts: string[] = []
    let cur: t.JSXMemberExpression | t.JSXIdentifier = name
    while (t.isJSXMemberExpression(cur)) {
      parts.unshift(cur.property.name)
      cur = cur.object
    }
    if (t.isJSXIdentifier(cur)) parts.unshift(cur.name)
    return parts.join('.')
  }
  if (t.isJSXNamespacedName(name)) return `${name.namespace.name}:${name.name.name}`
  return '?'
}

export function redesignerBabelPlugin(opts: RedesignerBabelPluginOpts): PluginObj {
  const { relPath, batch, onWarning = () => {} } = opts

  return {
    name: 'redesigner',
    visitor: {
      JSXFragment() {
        // Skip: <>…</> cannot accept props. Children visited via default traversal.
      },
      JSXOpeningElement(path: NodePath<t.JSXOpeningElement>) {
        try {
          const name = openingElementName(path.node)
          if (isReactWrapperName(name)) return // skip wrapper components

          const loc = path.node.loc
          if (!loc) return
          const comp = resolveEnclosingComponent(path, relPath)

          if (comp.componentName === '(module)') {
            // Special rule: module-scope JSX is attributed to synthetic (module) in the MANIFEST,
            // but we do NOT inject `data-redesigner-loc` on the opening element (validation gate §1.4.5).
            const componentKey = `${relPath}::(module)`
            batch.components[componentKey] = {
              filePath: relPath,
              exportKind: 'named',
              lineRange: comp.lineRange,
              displayName: '(module)',
            }
            const locString = formatLoc(relPath, loc.start.line, loc.start.column)
            batch.locs[locString] = { componentKey, filePath: relPath, componentName: '(module)' }
            return
          }

          // Reject user-declared displayName === "(module)"
          if (comp.componentName === '(module)') {
            throw new Error(`[redesigner] "(module)" is a reserved synthetic component name`)
          }

          const componentKey = `${relPath}::${comp.componentName}`
          batch.components[componentKey] = {
            filePath: relPath,
            exportKind: comp.exportKind,
            lineRange: comp.lineRange,
            displayName: comp.componentName,
          }
          const locString = formatLoc(relPath, loc.start.line, loc.start.column)
          batch.locs[locString] = {
            componentKey,
            filePath: relPath,
            componentName: comp.componentName,
          }

          // Inject attribute
          const attr = t.jsxAttribute(t.jsxIdentifier(ATTR_NAME), t.stringLiteral(locString))
          path.node.attributes.push(attr)
        } catch (err) {
          const line = path.node.loc?.start.line ?? '?'
          onWarning(`[redesigner] visitor error at ${relPath}:${line}: ${(err as Error).message}`)
        }
      },
    },
  }
}
