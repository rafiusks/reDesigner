import { type Editor, EditorSchema } from '@redesigner/core/schemas'

export { EditorSchema, type Editor }

export interface BuildDeeplinkArgs {
  editor: Editor
  filePath: string
  line: number
  col: number
  projectRoot: string
}

export class OutsideProjectRootError extends Error {
  constructor(filePath: string, projectRoot: string) {
    super(`filePath ${filePath} is not within projectRoot ${projectRoot}`)
    this.name = 'OutsideProjectRootError'
  }
}

function hasTraversal(p: string): boolean {
  return p.split('/').some((seg) => seg === '..' || seg === '.')
}

export function buildEditorDeeplink(args: BuildDeeplinkArgs): string {
  const { editor, filePath, line, col, projectRoot } = args

  if (!Number.isInteger(line) || !Number.isInteger(col) || line < 1 || col < 1) {
    throw new RangeError('line and col must be positive integers')
  }

  if (hasTraversal(filePath)) {
    throw new OutsideProjectRootError(filePath, projectRoot)
  }

  const normalizedProjectRoot = projectRoot.endsWith('/') ? projectRoot.slice(0, -1) : projectRoot

  if (!filePath.startsWith(`${normalizedProjectRoot}/`) && filePath !== normalizedProjectRoot) {
    throw new OutsideProjectRootError(filePath, projectRoot)
  }

  switch (editor) {
    case 'vscode':
      return `vscode://file${filePath}:${line}:${col}`
    case 'cursor':
      return `cursor://file${filePath}:${line}:${col}`
    case 'webstorm':
      return `webstorm://open?file=${encodeURIComponent(filePath)}&line=${line}&column=${col}`
    case 'zed':
      return `zed://file${filePath}:${line}:${col}`
  }
}
