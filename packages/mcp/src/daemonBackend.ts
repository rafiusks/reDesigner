import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import type { ComponentHandle } from '@redesigner/core'
import { FileBackend } from './backend.js'

interface ParsedHandoff {
  serverVersion: string
  instanceId: string
  pid: number
  host: string
  port: number
  token: string
  projectRoot: string
}

interface CachedHandoff {
  path: string
  parsed: ParsedHandoff | null
  urlPrefix: string | null
  authHeader: string | null
  instanceId: string | null
}

const WARM_TIMEOUT_MS = 250
const COLD_TIMEOUT_MS = 500
const COMPUTED_STYLES_TIMEOUT_MS = 6_000
const DOM_SUBTREE_TIMEOUT_MS = 11_000
const UNREACHABLE_TTL_MS = 1_000
const AUTH_CIRCUIT_BREAKER_LIMIT = 5
const AUTH_CIRCUIT_BREAKER_WINDOW_MS = 5_000
const AUTH_RETRY_SLEEP_MS = 100

export class DaemonBackend extends FileBackend {
  private handoff: CachedHandoff | null = null
  private unreachableUntil = 0
  private unreachableReason: string | null = null
  private firstVerdictLogged = false
  private wasWarmLastCall = false
  private consecutiveAuthFails = 0
  private lastAuthFailAt = 0
  private lastAuthFailInstanceId: string | null = null
  private permanentUnreachable = false

  private isUnreachable(): boolean {
    return this.permanentUnreachable || Date.now() < this.unreachableUntil
  }

  private markUnreachable(reason: string, permanent = false): void {
    this.unreachableUntil = Date.now() + UNREACHABLE_TTL_MS
    if (permanent) this.permanentUnreachable = true
    if (this.unreachableReason !== reason) {
      this.unreachableReason = reason
      this.firstVerdictLogged = true
    }
  }

  private markReachable(): void {
    this.unreachableUntil = 0
    this.unreachableReason = null
  }

  private resolveHandoffPath(): string {
    let realRoot: string
    try {
      realRoot = fs.realpathSync(this.opts.projectRoot)
    } catch {
      realRoot = this.opts.projectRoot
    }
    const projectHash = crypto.createHash('sha256').update(realRoot).digest('hex').slice(0, 16)
    const uid =
      process.platform === 'win32'
        ? (process.env.USERNAME ?? 'w')
        : String(process.getuid?.() ?? 'w')
    if (process.platform === 'linux') {
      const root = process.env.XDG_RUNTIME_DIR ?? path.join(os.tmpdir(), `redesigner-${uid}`)
      return path.join(root, 'redesigner', projectHash, 'daemon-v1.json')
    }
    if (process.platform === 'darwin') {
      return path.join(os.tmpdir(), `com.redesigner.${uid}`, projectHash, 'daemon-v1.json')
    }
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'redesigner', uid, projectHash, 'daemon-v1.json')
  }

  private invalidateParsed(): void {
    if (this.handoff) {
      this.handoff = {
        path: this.handoff.path,
        parsed: null,
        urlPrefix: null,
        authHeader: null,
        instanceId: null,
      }
    }
  }

  private discoverHandoff(): void {
    const p = this.handoff?.path ?? this.resolveHandoffPath()
    // Reset cached handoff to invalidated state; `path` survives invalidation.
    this.handoff = {
      path: p,
      parsed: null,
      urlPrefix: null,
      authHeader: null,
      instanceId: null,
    }
    let st: fs.Stats
    try {
      st = fs.lstatSync(p)
    } catch {
      this.markUnreachable('handoff missing')
      return
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      this.markUnreachable('handoff invalid type')
      return
    }
    if (process.platform !== 'win32') {
      const currentUid = process.getuid?.()
      if (typeof currentUid === 'number' && st.uid !== currentUid) {
        this.markUnreachable('handoff uid mismatch')
        return
      }
      if ((st.mode & 0o077) !== 0) {
        this.markUnreachable('handoff mode unsafe')
        return
      }
    }
    let parsed: ParsedHandoff
    try {
      const raw = fs.readFileSync(p, 'utf8')
      parsed = JSON.parse(raw) as ParsedHandoff
    } catch {
      this.markUnreachable('handoff parse failed')
      return
    }
    if (
      !parsed ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.host !== 'string' ||
      typeof parsed.port !== 'number' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.instanceId !== 'string'
    ) {
      this.markUnreachable('handoff shape invalid')
      return
    }
    try {
      process.kill(parsed.pid, 0)
    } catch {
      this.markUnreachable('handoff pid dead')
      return
    }
    this.handoff = {
      path: p,
      parsed,
      urlPrefix: `http://${parsed.host}:${parsed.port}`,
      authHeader: `Bearer ${parsed.token}`,
      instanceId: parsed.instanceId,
    }
    this.markReachable()
  }

  private async httpRequest(
    urlPath: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    if (!this.handoff?.urlPrefix || !this.handoff?.authHeader) {
      throw new Error('handoff not cached')
    }
    // AbortSignal.timeout is single-shot + GC-friendly; avoids the AbortController
    // leak pattern (nodejs/undici#2198). Do NOT wrap in AbortSignal.any — that
    // composition reintroduces the leak (nodejs/node#57736).
    return fetch(`${this.handoff.urlPrefix}${urlPath}`, {
      ...init,
      redirect: 'error',
      headers: {
        Authorization: this.handoff.authHeader,
        'Content-Type': 'application/json',
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  /**
   * Record a 401 and return true if the breaker tripped (permanent-unreachable).
   * Counter resets on instanceId change (daemon respawn rotates token benignly).
   */
  private recordAuthFail(instanceId: string | null): boolean {
    const now = Date.now()
    if (instanceId !== this.lastAuthFailInstanceId) {
      this.consecutiveAuthFails = 0
    }
    if (this.lastAuthFailAt !== 0 && now - this.lastAuthFailAt < AUTH_CIRCUIT_BREAKER_WINDOW_MS) {
      this.consecutiveAuthFails++
    } else {
      this.consecutiveAuthFails = 1
    }
    this.lastAuthFailAt = now
    this.lastAuthFailInstanceId = instanceId
    return this.consecutiveAuthFails >= AUTH_CIRCUIT_BREAKER_LIMIT
  }

  private ensureHandoff(): boolean {
    if (!this.handoff?.parsed) {
      this.discoverHandoff()
    }
    return !!this.handoff?.parsed
  }

  private currentTimeout(): number {
    return this.wasWarmLastCall ? WARM_TIMEOUT_MS : COLD_TIMEOUT_MS
  }

  override async getCurrentSelection(): Promise<ComponentHandle | null> {
    if (this.isUnreachable()) return null
    if (!this.ensureHandoff()) return null
    try {
      const res = await this.httpRequest('/selection', { method: 'GET' }, this.currentTimeout())
      if (res.status === 401) {
        const instanceId = this.handoff?.instanceId ?? null
        if (this.recordAuthFail(instanceId)) {
          this.markUnreachable('auth persistent', true)
          return null
        }
        await new Promise((resolve) => setTimeout(resolve, AUTH_RETRY_SLEEP_MS))
        this.invalidateParsed()
        this.discoverHandoff()
        if (!this.handoff?.parsed) return null
        try {
          const res2 = await this.httpRequest('/selection', { method: 'GET' }, COLD_TIMEOUT_MS)
          if (res2.status === 401) {
            this.markUnreachable('auth failed after re-discovery')
            return null
          }
          if (res2.status === 503) return null
          if (!res2.ok) {
            this.markUnreachable(`HTTP ${res2.status}`)
            this.wasWarmLastCall = false
            return null
          }
          const body2 = (await res2.json()) as { current: ComponentHandle | null }
          this.consecutiveAuthFails = 0
          this.markReachable()
          this.wasWarmLastCall = true
          return body2.current
        } catch {
          this.markUnreachable('connection failed after re-discovery')
          this.wasWarmLastCall = false
          return null
        }
      }
      if (res.status === 503) return null // NotReady — daemon healthy, selection empty
      if (!res.ok) {
        this.markUnreachable(`HTTP ${res.status}`)
        this.wasWarmLastCall = false
        return null
      }
      const body = (await res.json()) as { current: ComponentHandle | null }
      this.markReachable()
      this.wasWarmLastCall = true
      return body.current
    } catch {
      this.invalidateParsed()
      this.discoverHandoff()
      if (!this.handoff?.parsed) {
        this.wasWarmLastCall = false
        return null
      }
      try {
        const res = await this.httpRequest('/selection', { method: 'GET' }, COLD_TIMEOUT_MS)
        if (res.status === 401) {
          const instanceId = this.handoff?.instanceId ?? null
          if (this.recordAuthFail(instanceId)) {
            this.markUnreachable('auth persistent', true)
          } else {
            this.markUnreachable('auth failed after re-discovery')
          }
          this.wasWarmLastCall = false
          return null
        }
        if (res.status === 503) return null
        if (!res.ok) {
          this.markUnreachable('connection failed after re-discovery')
          this.wasWarmLastCall = false
          return null
        }
        const body = (await res.json()) as { current: ComponentHandle | null }
        this.markReachable()
        this.wasWarmLastCall = true
        return body.current
      } catch {
        this.markUnreachable('persistent connection failure')
        this.wasWarmLastCall = false
        return null
      }
    }
  }

  override async getRecentSelections(n: number): Promise<ComponentHandle[]> {
    if (this.isUnreachable()) return []
    if (!this.ensureHandoff()) return []
    try {
      const res = await this.httpRequest(
        `/selection/recent?n=${n}`,
        { method: 'GET' },
        this.currentTimeout(),
      )
      if (res.status === 401) {
        const instanceId = this.handoff?.instanceId ?? null
        if (this.recordAuthFail(instanceId)) {
          this.markUnreachable('auth persistent', true)
          return []
        }
        await new Promise((resolve) => setTimeout(resolve, AUTH_RETRY_SLEEP_MS))
        this.invalidateParsed()
        this.discoverHandoff()
        if (!this.handoff?.parsed) return []
        try {
          const res2 = await this.httpRequest(
            `/selection/recent?n=${n}`,
            { method: 'GET' },
            COLD_TIMEOUT_MS,
          )
          if (!res2.ok) {
            this.markUnreachable(
              res2.status === 401 ? 'auth failed after re-discovery' : `HTTP ${res2.status}`,
            )
            this.wasWarmLastCall = false
            return []
          }
          this.consecutiveAuthFails = 0
          this.markReachable()
          this.wasWarmLastCall = true
          return (await res2.json()) as ComponentHandle[]
        } catch {
          this.markUnreachable('connection failed after re-discovery')
          this.wasWarmLastCall = false
          return []
        }
      }
      if (res.status === 503) return []
      if (!res.ok) {
        this.markUnreachable(`HTTP ${res.status}`)
        this.wasWarmLastCall = false
        return []
      }
      this.markReachable()
      this.wasWarmLastCall = true
      return (await res.json()) as ComponentHandle[]
    } catch {
      this.invalidateParsed()
      this.discoverHandoff()
      if (!this.handoff?.parsed) {
        this.wasWarmLastCall = false
        return []
      }
      try {
        const res = await this.httpRequest(
          `/selection/recent?n=${n}`,
          { method: 'GET' },
          COLD_TIMEOUT_MS,
        )
        if (!res.ok) {
          this.markUnreachable('connection failed after re-discovery')
          this.wasWarmLastCall = false
          return []
        }
        this.markReachable()
        this.wasWarmLastCall = true
        return (await res.json()) as ComponentHandle[]
      } catch {
        this.markUnreachable('persistent connection failure')
        this.wasWarmLastCall = false
        return []
      }
    }
  }

  override async getComputedStyles(selectionId: string): Promise<Record<string, string> | null> {
    if (this.isUnreachable()) {
      throw new McpError(ErrorCode.InternalError, 'daemon unreachable')
    }
    if (!this.ensureHandoff()) {
      throw new McpError(ErrorCode.InternalError, 'daemon unreachable')
    }
    const body = JSON.stringify({ selectionId })
    const doRequest = (): Promise<Response> =>
      this.httpRequest('/computed_styles', { method: 'POST', body }, COMPUTED_STYLES_TIMEOUT_MS)
    let res: Response
    try {
      res = await doRequest()
    } catch {
      this.invalidateParsed()
      this.discoverHandoff()
      if (!this.handoff?.parsed) {
        throw new McpError(ErrorCode.InternalError, 'daemon unreachable')
      }
      try {
        res = await doRequest()
      } catch {
        this.markUnreachable('persistent connection failure')
        throw new McpError(ErrorCode.InternalError, 'daemon unreachable')
      }
    }
    if (res.status === 401) {
      const instanceId = this.handoff?.instanceId ?? null
      if (this.recordAuthFail(instanceId)) {
        this.markUnreachable('auth persistent', true)
        throw new McpError(ErrorCode.InternalError, 'daemon unreachable')
      }
      await new Promise((resolve) => setTimeout(resolve, AUTH_RETRY_SLEEP_MS))
      this.invalidateParsed()
      this.discoverHandoff()
      if (!this.handoff?.parsed) {
        throw new McpError(ErrorCode.InternalError, 'daemon unreachable')
      }
      try {
        res = await doRequest()
      } catch {
        this.markUnreachable('connection failed after re-discovery')
        throw new McpError(ErrorCode.InternalError, 'daemon unreachable')
      }
      if (res.status === 401) {
        this.markUnreachable('auth failed after re-discovery')
        throw new McpError(ErrorCode.InternalError, 'daemon unreachable')
      }
      this.consecutiveAuthFails = 0
    }
    if (res.status === 424) {
      throw new McpError(ErrorCode.InternalError, 'no browser extension connected')
    }
    if (res.status === 504) {
      throw new McpError(ErrorCode.InternalError, 'extension did not respond in time')
    }
    if (res.status === 503) {
      throw new McpError(ErrorCode.InternalError, 'extension disconnected mid-request')
    }
    if (res.status === 400 || res.status === 404) {
      let detail = `HTTP ${res.status}`
      try {
        const problem = (await res.json()) as { detail?: string; title?: string }
        detail = problem.detail ?? problem.title ?? detail
      } catch {}
      throw new McpError(ErrorCode.InvalidRequest, detail)
    }
    if (!res.ok) {
      throw new McpError(ErrorCode.InternalError, `HTTP ${res.status}`)
    }
    this.markReachable()
    this.wasWarmLastCall = true
    const body2 = (await res.json()) as { styles: Record<string, string> }
    return body2.styles
  }

  override async getDomSubtree(selectionId: string, depth: number): Promise<unknown | null> {
    if (this.isUnreachable()) {
      throw new McpError(ErrorCode.InternalError, 'daemon unreachable')
    }
    if (!this.ensureHandoff()) {
      throw new McpError(ErrorCode.InternalError, 'daemon unreachable')
    }
    const body = JSON.stringify({ selectionId, depth })
    const doRequest = (): Promise<Response> =>
      this.httpRequest('/dom_subtree', { method: 'POST', body }, DOM_SUBTREE_TIMEOUT_MS)
    let res: Response
    try {
      res = await doRequest()
    } catch {
      this.invalidateParsed()
      this.discoverHandoff()
      if (!this.handoff?.parsed) {
        throw new McpError(ErrorCode.InternalError, 'daemon unreachable')
      }
      try {
        res = await doRequest()
      } catch {
        this.markUnreachable('persistent connection failure')
        throw new McpError(ErrorCode.InternalError, 'daemon unreachable')
      }
    }
    if (res.status === 401) {
      const instanceId = this.handoff?.instanceId ?? null
      if (this.recordAuthFail(instanceId)) {
        this.markUnreachable('auth persistent', true)
        throw new McpError(ErrorCode.InternalError, 'daemon unreachable')
      }
      await new Promise((resolve) => setTimeout(resolve, AUTH_RETRY_SLEEP_MS))
      this.invalidateParsed()
      this.discoverHandoff()
      if (!this.handoff?.parsed) {
        throw new McpError(ErrorCode.InternalError, 'daemon unreachable')
      }
      try {
        res = await doRequest()
      } catch {
        this.markUnreachable('connection failed after re-discovery')
        throw new McpError(ErrorCode.InternalError, 'daemon unreachable')
      }
      if (res.status === 401) {
        this.markUnreachable('auth failed after re-discovery')
        throw new McpError(ErrorCode.InternalError, 'daemon unreachable')
      }
      this.consecutiveAuthFails = 0
    }
    if (res.status === 424) {
      throw new McpError(ErrorCode.InternalError, 'no browser extension connected')
    }
    if (res.status === 400 || res.status === 404) {
      let detail = `HTTP ${res.status}`
      try {
        const problem = (await res.json()) as { detail?: string; title?: string }
        detail = problem.detail ?? problem.title ?? detail
      } catch {}
      throw new McpError(ErrorCode.InvalidRequest, detail)
    }
    if (!res.ok) {
      throw new McpError(ErrorCode.InternalError, `HTTP ${res.status}`)
    }
    this.markReachable()
    this.wasWarmLastCall = true
    const body2 = (await res.json()) as { tree: unknown }
    return body2.tree
  }
}
