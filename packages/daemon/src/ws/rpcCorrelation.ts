export class RpcCorrelation {
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()
  private active = 0
  constructor(private concurrencyLimit: number) {}

  tryAcquire(): boolean {
    if (this.active >= this.concurrencyLimit) return false
    return true
  }

  inFlight(): number {
    return this.active
  }

  register(id: string, timeoutMs: number): Promise<unknown> {
    this.active++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        this.active = Math.max(0, this.active - 1)
        reject(new Error(`rpc timeout: ${id}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  resolve(id: string, value: unknown): void {
    const entry = this.pending.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(id)
    this.active = Math.max(0, this.active - 1)
    entry.resolve(value)
  }

  reject(id: string, err: Error): void {
    const entry = this.pending.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(id)
    this.active = Math.max(0, this.active - 1)
    entry.reject(err)
  }

  rejectAll(err: Error): void {
    for (const [id] of this.pending) this.reject(id, err)
  }
}
