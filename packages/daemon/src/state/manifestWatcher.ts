import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ManifestSchema, safeJsonParse } from '@redesigner/core'
import type { Manifest } from '@redesigner/core'
import type { Logger } from '../logger.js'

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const DEBOUNCE_MS = 100
const STAT_POLL_MS = 3000

export class ManifestWatcher {
  private cached: Manifest | null = null
  private cachedContentHash: string | null = null
  private cachedMtimeMs = 0
  private watcher: fs.FSWatcher | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private statPollTimer: NodeJS.Timeout | null = null
  private inFlight = false
  private rereadPending = false
  private stopped = false
  public stats = { events: 0, validated: 0, rejected: 0, statPollRecoveries: 0 }

  constructor(
    private manifestPath: string,
    private onValidated: (m: Manifest) => void,
    private fsReadFile: typeof fs.promises.readFile,
    private fsStat: typeof fs.promises.stat,
    private logger: Logger,
  ) {}

  async start(): Promise<void> {
    const watchDir = path.dirname(this.manifestPath)
    const basename = path.basename(this.manifestPath)
    fs.mkdirSync(watchDir, { recursive: true })
    try {
      const st = await this.fsStat(this.manifestPath)
      if (st.isFile()) await this.reread()
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    this.watcher = fs.watch(watchDir, { persistent: false })
    this.watcher.on('change', (_, filename) => {
      if (filename === basename) this.scheduleReread()
    })
    this.watcher.on('error', (err) => {
      this.logger.error('[watcher] error; restart in 1s', { err: String(err) })
      setTimeout(() => {
        void this.restart()
      }, 1000).unref()
    })
    this.statPollTimer = setInterval(() => {
      void this.statPollCheck()
    }, STAT_POLL_MS)
    this.statPollTimer.unref()
  }

  private async restart(): Promise<void> {
    if (this.stopped) return
    try {
      this.watcher?.close()
      await this.start()
      await this.reread()
    } catch (err) {
      this.logger.error('[watcher] restart failed; operating on stale cache', { err: String(err) })
    }
  }

  private scheduleReread(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      void this.reread()
    }, DEBOUNCE_MS)
  }

  private async statPollCheck(): Promise<void> {
    let st: fs.Stats
    try {
      st = await this.fsStat(this.manifestPath)
    } catch {
      return
    }
    if (
      st.mtimeMs > this.cachedMtimeMs &&
      !this.inFlight &&
      !this.rereadPending &&
      !this.debounceTimer
    ) {
      this.stats.statPollRecoveries++
      this.logger.warn('[watcher] stat-poll recovered missed event')
      this.scheduleReread()
    }
  }

  private async reread(): Promise<void> {
    if (this.inFlight) {
      this.rereadPending = true
      return
    }
    this.inFlight = true
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.stats.events++
    try {
      const fd = await fs.promises.open(this.manifestPath, 'r')
      try {
        const st = await fd.stat()
        if (st.size > MAX_MANIFEST_BYTES) {
          this.stats.rejected++
          this.logger.warn('[watcher] manifest exceeds 2MB cap; keeping cached')
          return
        }
        const buf = Buffer.alloc(st.size)
        const { bytesRead } = await fd.read(buf, 0, st.size, 0)
        if (bytesRead !== st.size) {
          this.stats.rejected++
          this.logger.warn('[watcher] bytesRead mismatch; keeping cached')
          return
        }
        const raw = buf.toString('utf8')
        const parsedJson = safeJsonParse(raw)
        const validated = ManifestSchema.safeParse(parsedJson)
        if (!validated.success) {
          this.stats.rejected++
          this.logger.warn('[watcher] schema rejected; keeping cached', {
            issues: validated.error.issues.length,
          })
          return
        }
        const recomputedHash = crypto.createHash('sha256').update(raw).digest('hex')
        const reconciled: Manifest = { ...validated.data, contentHash: recomputedHash }
        if (recomputedHash === this.cachedContentHash) {
          this.cachedMtimeMs = st.mtimeMs
          return
        }
        this.cached = reconciled
        this.cachedContentHash = recomputedHash
        this.cachedMtimeMs = st.mtimeMs
        this.stats.validated++
        this.onValidated(reconciled)
      } finally {
        await fd.close()
      }
    } catch (err) {
      this.stats.rejected++
      this.logger.warn('[watcher] reread failed; keeping cached', { err: String(err) })
    } finally {
      this.inFlight = false
      if (this.rereadPending) {
        this.rereadPending = false
        void this.reread()
      }
    }
  }

  getCached(): Manifest | null {
    return this.cached
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.statPollTimer) clearInterval(this.statPollTimer)
    this.watcher?.close()
    this.cached = null
  }
}
