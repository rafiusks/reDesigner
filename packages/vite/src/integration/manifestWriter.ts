import { randomBytes } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { computeContentHash } from '../core/contentHash'
import type { Clock, Logger, PerFileBatch } from '../core/types-internal'
import type { Manifest } from '../core/types-public'

const DEBOUNCE_MS = 200
const MAX_WAIT_MS = 1000
const RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600, 3200]

export interface ManifestWriterOptions {
  projectRoot: string
  manifestPath: string
  framework?: string
  clock?: Clock
  logger?: Logger
}

export class ManifestWriter {
  private state: Map<string, PerFileBatch> = new Map()
  private flushTimer: unknown = null
  private maxWaitTimer: unknown = null
  private firstPendingAt: number | null = null
  private flushInFlight: Promise<void> | null = null
  private seq = 0
  private onFlushResolvers: Array<{ seq: number; resolve: () => void }> = []
  private lockFd: number | null = null
  private shutdownCalled = false
  private clock: Clock
  private logger: Logger
  private readonly manifestDir: string
  private readonly manifestBase: string

  constructor(private opts: ManifestWriterOptions) {
    this.manifestDir = path.dirname(opts.manifestPath)
    this.manifestBase = path.basename(opts.manifestPath)
    this.clock = opts.clock ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
    }
    this.logger = opts.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }

    mkdirSync(this.manifestDir, { recursive: true })

    // wx flag detects a second dev server on the same manifestPath (collision → throw, not overwrite).
    const lockPath = `${opts.manifestPath}.owner-lock`
    try {
      this.lockFd = openSync(lockPath, 'wx')
    } catch {
      throw new Error(
        `[redesigner] two dev servers targeting the same manifestPath (${opts.manifestPath}) — pass distinct \`options.manifestPath\` or separate \`config.root\``,
      )
    }

    this.startupSweep(this.manifestDir)
    this.writeSync(this.buildManifest())
  }

  private startupSweep(dir: string) {
    try {
      for (const f of readdirSync(dir)) {
        if (/^manifest\.json\.tmp-/.test(f)) {
          try {
            unlinkSync(path.join(dir, f))
          } catch {}
        }
      }
    } catch {}
  }

  private buildManifest(): Manifest {
    const components: Manifest['components'] = {}
    const locs: Manifest['locs'] = {}
    for (const batch of this.state.values()) {
      Object.assign(components, batch.components)
      Object.assign(locs, batch.locs)
    }
    const base: Manifest = {
      schemaVersion: '1.0',
      framework: this.opts.framework ?? 'react',
      generatedAt: new Date().toISOString(),
      contentHash: '',
      components,
      locs,
    }
    base.contentHash = computeContentHash(base)
    return base
  }

  commitFile(filePath: string, batch: PerFileBatch): void {
    this.state.set(filePath, batch)
    this.scheduleFlush()
  }

  private scheduleFlush() {
    if (this.firstPendingAt === null) this.firstPendingAt = this.clock.now()
    if (this.flushTimer) this.clock.clearTimeout(this.flushTimer)
    this.flushTimer = this.clock.setTimeout(() => this.doFlush(), DEBOUNCE_MS)
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = this.clock.setTimeout(() => this.doFlush(), MAX_WAIT_MS)
    }
  }

  private async doFlush(): Promise<void> {
    if (this.flushTimer) {
      this.clock.clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.maxWaitTimer) {
      this.clock.clearTimeout(this.maxWaitTimer)
      this.maxWaitTimer = null
    }
    this.firstPendingAt = null

    if (this.flushInFlight) return this.flushInFlight
    // this.state is a stable Map reference — snapshot its entries so we can detect per-file
    // replacements that arrived while the flush was in flight.
    const snapshotEntries = new Map(this.state)
    const manifest = this.buildManifest()
    const seq = ++this.seq

    this.flushInFlight = (async () => {
      try {
        await this.flush(manifest)
        if (this.snapshotChanged(snapshotEntries)) {
          this.scheduleFlush()
        }
      } finally {
        this.flushInFlight = null
        const remaining: typeof this.onFlushResolvers = []
        for (const r of this.onFlushResolvers) {
          if (r.seq <= seq) r.resolve()
          else remaining.push(r)
        }
        this.onFlushResolvers = remaining
      }
    })()
    return this.flushInFlight
  }

  private snapshotChanged(snapshot: Map<string, PerFileBatch>): boolean {
    // Per-entry reference compare — commitFile replaces batch objects, so identity suffices.
    if (snapshot.size !== this.state.size) return true
    for (const [k, v] of this.state) if (snapshot.get(k) !== v) return true
    return false
  }

  private async flush(manifest: Manifest): Promise<void> {
    const tmpName = `${this.manifestBase}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    const tmpPath = path.join(this.manifestDir, tmpName)
    const data = `${JSON.stringify(manifest, null, 2)}\n`

    writeFileSync(tmpPath, data)

    for (let i = 0; ; i++) {
      try {
        renameSync(tmpPath, this.opts.manifestPath)
        if (i >= 2) this.logger.warn(`[redesigner] atomic rename succeeded after ${i} retries`)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code
        if (i >= RETRY_DELAYS_MS.length) {
          try {
            unlinkSync(tmpPath)
          } catch {}
          this.logger.error(
            `[redesigner] atomic rename failed after ${RETRY_DELAYS_MS.length + 1} attempts: ${err}`,
          )
          return
        }
        if (code === 'EPERM' || code === 'EBUSY') {
          const delay = RETRY_DELAYS_MS[i] ?? 0
          this.logger.debug?.(
            `[redesigner] rename retry ${i + 1}/${RETRY_DELAYS_MS.length} in ${delay}ms (${code})`,
          )
          await new Promise<void>((r) => this.clock.setTimeout(() => r(), delay))
          continue
        }
        if (code === 'EXDEV') {
          this.logger.warn(
            `[redesigner] EXDEV (cross-device rename) — plugin bug, please file issue. tmp=${tmpPath} target=${this.opts.manifestPath}`,
          )
        }
        try {
          unlinkSync(tmpPath)
        } catch {}
        this.logger.warn(`[redesigner] atomic rename failed: ${err}`)
        return
      }
    }
  }

  private writeSync(manifest: Manifest): void {
    const data = `${JSON.stringify(manifest, null, 2)}\n`
    writeFileSync(this.opts.manifestPath, data)
  }

  /** Forces a flush and resolves after it lands. Test seam. */
  async quiesce(): Promise<void> {
    await this.doFlush()
  }

  async onFlush(seq: number): Promise<void> {
    if (seq <= this.seq && !this.flushInFlight) return
    return new Promise((resolve) => this.onFlushResolvers.push({ seq, resolve }))
  }

  async shutdown(): Promise<void> {
    if (this.shutdownCalled) return
    this.shutdownCalled = true
    if (this.flushTimer) {
      this.clock.clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.maxWaitTimer) {
      this.clock.clearTimeout(this.maxWaitTimer)
      this.maxWaitTimer = null
    }
    try {
      await this.flush(this.buildManifest())
    } catch (err) {
      // Last-resort: config.logger may be torn down
      console.error(`[redesigner] shutdown flush failed: ${err}`)
    }
    if (this.lockFd !== null) {
      try {
        closeSync(this.lockFd)
      } catch {}
      try {
        unlinkSync(`${this.opts.manifestPath}.owner-lock`)
      } catch {}
      this.lockFd = null
    }
    this.state.clear()
    this.onFlushResolvers = []
  }
}
