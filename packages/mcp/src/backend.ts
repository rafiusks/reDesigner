import { readFile, stat } from 'node:fs/promises'
import {
  type ComponentHandle,
  type Manifest,
  ManifestSchema,
  SelectionFileSchema,
  safeJsonParse,
} from '@redesigner/core'
import { FileTooLargeError, toMcpError } from './errors'

export interface Backend {
  getManifest(): Promise<Manifest>
  getCurrentSelection(): Promise<ComponentHandle | null>
  getRecentSelections(n: number): Promise<ComponentHandle[]>
  getComputedStyles(selectionId: string): Promise<Record<string, string> | null>
  getDomSubtree(selectionId: string, depth: number): Promise<unknown | null>
}

interface FileBackendOptions {
  projectRoot: string
  manifestPath: string
  selectionPath: string
}

const MANIFEST_SIZE_LIMIT = 10 * 1024 * 1024
const SELECTION_SIZE_LIMIT = 1 * 1024 * 1024
const CACHE_TTL_MS = 100

interface CacheEntry<T> {
  data: T
  mtimeMs: number
  expiresAt: number
}

export class FileBackend implements Backend {
  private manifestCache: CacheEntry<Manifest> | null = null
  private selectionCache: CacheEntry<{
    current: ComponentHandle | null
    history: ComponentHandle[]
  }> | null = null

  constructor(private readonly opts: FileBackendOptions) {}

  async getManifest(): Promise<Manifest> {
    return this.readCached(
      this.opts.manifestPath,
      'reading .redesigner/manifest.json',
      MANIFEST_SIZE_LIMIT,
      (obj) => {
        const parsed = ManifestSchema.safeParse(obj)
        if (!parsed.success) throw parsed.error
        return parsed.data
      },
      (entry) => {
        this.manifestCache = entry
      },
      () => this.manifestCache,
    )
  }

  async getCurrentSelection(): Promise<ComponentHandle | null> {
    const selection = await this.readSelection()
    return selection.current
  }

  async getRecentSelections(n: number): Promise<ComponentHandle[]> {
    const selection = await this.readSelection()
    return selection.history.slice(0, n)
  }

  async getComputedStyles(_selectionId: string): Promise<Record<string, string> | null> {
    return null
  }

  async getDomSubtree(_selectionId: string, _depth: number): Promise<unknown | null> {
    return null
  }

  private async readSelection(): Promise<{
    current: ComponentHandle | null
    history: ComponentHandle[]
  }> {
    return this.readCached(
      this.opts.selectionPath,
      'reading .redesigner/selection.json',
      SELECTION_SIZE_LIMIT,
      (obj) => {
        const parsed = SelectionFileSchema.safeParse(obj)
        if (!parsed.success) throw parsed.error
        return parsed.data
      },
      (entry) => {
        this.selectionCache = entry
      },
      () => this.selectionCache,
      () => ({ current: null, history: [] }),
    )
  }

  private async readCached<T>(
    filePath: string,
    context: string,
    limit: number,
    validate: (obj: unknown) => T,
    setCache: (entry: CacheEntry<T>) => void,
    getCache: () => CacheEntry<T> | null,
    defaultOnMissing?: () => T,
  ): Promise<T> {
    let statResult: Awaited<ReturnType<typeof stat>>
    try {
      statResult = await stat(filePath)
    } catch (err) {
      if (defaultOnMissing && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return defaultOnMissing()
      }
      throw toMcpError(err, context)
    }
    if (statResult.size > limit) {
      throw toMcpError(new FileTooLargeError(limit, statResult.size), context)
    }

    const cached = getCache()
    if (cached && cached.mtimeMs === statResult.mtimeMs && cached.expiresAt > Date.now()) {
      return cached.data
    }

    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (err) {
      throw toMcpError(err, context)
    }

    let obj: unknown
    try {
      obj = safeJsonParse(raw)
    } catch (err) {
      throw toMcpError(err, context)
    }

    let data: T
    try {
      data = validate(obj)
    } catch (err) {
      throw toMcpError(err, context)
    }

    setCache({ data, mtimeMs: statResult.mtimeMs, expiresAt: Date.now() + CACHE_TTL_MS })
    return data
  }
}
