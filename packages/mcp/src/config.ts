import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

export interface ResolvedConfig {
  projectRoot: string
  manifestPath: string
  manifestRelativePath: string
  selectionPath: string
  packageJson: { name?: string }
  viteConfigPresent: boolean
  serverVersion: string
}

const DEFAULT_MANIFEST_REL = '.redesigner/manifest.json'
const DEFAULT_SELECTION_REL = '.redesigner/selection.json'

function readServerVersion(): string {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url)
    const raw = readFileSync(pkgUrl, 'utf8')
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function buildFromRoot(
  projectRoot: string,
  manifestRelativePath = DEFAULT_MANIFEST_REL,
): ResolvedConfig {
  let packageJson: { name?: string } = {}
  try {
    const raw = readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { name?: string }
    packageJson = { ...(parsed.name ? { name: parsed.name } : {}) }
  } catch {
    // missing or malformed — fall back to basename
  }
  if (!packageJson.name) packageJson.name = path.basename(projectRoot)

  const viteConfigPresent = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'].some((f) =>
    existsSync(path.join(projectRoot, f)),
  )

  return {
    projectRoot,
    manifestPath: path.join(projectRoot, manifestRelativePath),
    manifestRelativePath,
    selectionPath: path.join(projectRoot, DEFAULT_SELECTION_REL),
    packageJson,
    viteConfigPresent,
    serverVersion: readServerVersion(),
  }
}

function assertHasManifest(projectRoot: string): void {
  if (!existsSync(path.join(projectRoot, DEFAULT_MANIFEST_REL))) {
    throw new Error(
      `[redesigner/mcp] no .redesigner/manifest.json found at ${projectRoot} — did you run 'vite dev' in this project?`,
    )
  }
}

export function resolveConfig(
  argv: { project?: string; manifest?: string },
  cwd: string,
  env: NodeJS.ProcessEnv,
): ResolvedConfig {
  const home = env.HOME ?? env.USERPROFILE ?? null
  const manifestRelativePath = argv.manifest ?? DEFAULT_MANIFEST_REL

  if (argv.project) {
    let p: string
    try {
      p = realpathSync.native(path.resolve(argv.project))
    } catch {
      throw new Error(
        `[redesigner/mcp] --project path does not exist or cannot be read: ${argv.project}`,
      )
    }
    assertHasManifest(p)
    return buildFromRoot(p, manifestRelativePath)
  }

  let cur: string
  try {
    cur = realpathSync.native(path.resolve(cwd))
  } catch {
    throw new Error(`[redesigner/mcp] cwd does not exist or cannot be read: ${cwd}`)
  }

  while (true) {
    if (home && cur === home) break
    const parent = path.dirname(cur)
    if (parent === cur) break

    if (existsSync(path.join(cur, '.redesigner/manifest.json'))) {
      if (!existsSync(path.join(cur, 'package.json'))) {
        cur = parent
        continue
      }
      const resolved = buildFromRoot(cur, manifestRelativePath)
      process.stderr.write(`[redesigner/mcp] resolved project root: ${resolved.projectRoot}\n`)
      return resolved
    }

    if (existsSync(path.join(cur, 'package.json')) && cur !== cwd) break
    cur = parent
  }

  throw new Error(
    '[redesigner/mcp] no .redesigner/manifest.json found walking up from cwd (stopped at HOME or repo boundary). ' +
      'Run `vite dev` in a project with @redesigner/vite installed, or pass --project <path>.',
  )
}
