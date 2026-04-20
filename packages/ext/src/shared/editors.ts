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

export function buildEditorDeeplink(args: BuildDeeplinkArgs): string {
  const { editor, filePath, line, col, projectRoot } = args

  // Normalize projectRoot by removing trailing slash for consistent comparison
  const normalizedProjectRoot = projectRoot.endsWith('/') ? projectRoot.slice(0, -1) : projectRoot

  // Check if filePath is within projectRoot
  if (!filePath.startsWith(`${normalizedProjectRoot}/`) && filePath !== normalizedProjectRoot) {
    throw new OutsideProjectRootError(filePath, projectRoot)
  }

  switch (editor) {
    case 'vscode':
      return `vscode://file/${filePath}:${line}:${col}`
    case 'cursor':
      return `cursor://file/${filePath}:${line}:${col}`
    case 'webstorm':
      return `webstorm://open?file=${filePath}&line=${line}&column=${col}`
    case 'zed':
      return `zed://file${filePath}:${line}:${col}`
  }
}
