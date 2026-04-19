import type { WebSocket } from 'ws'

export interface RingEntry {
  seq: number
  type: string
}

export type ResyncDecision =
  | { kind: 'hello-only' }
  | { kind: 'hello-gap'; droppedFrom: number; droppedTo: number }

const RING_CAP = 1024
const HARD_WATERMARK_BYTES = 1 * 1024 * 1024
const DRAIN_LOOP_LIMIT = 3

interface Subscriber {
  ws: WebSocket
  paused: boolean
  drainLoopCount: number
  lastDeliveredSeq: number
}

export class EventBus {
  private seq = 0
  private ring: RingEntry[] = []
  private subscribers = new Set<Subscriber>()

  mintSeq(): number {
    this.seq++
    return this.seq
  }

  currentSeq(): number {
    return this.seq
  }

  recordFrame(entry: RingEntry): void {
    this.ring.push(entry)
    if (this.ring.length > RING_CAP) this.ring.shift()
  }

  ringSize(): number {
    return this.ring.length
  }

  earliestRetainedSeq(): number {
    return this.ring[0]?.seq ?? 0
  }

  computeResync(since: number | undefined, current: number): ResyncDecision {
    if (since === undefined || since >= current) return { kind: 'hello-only' }
    const earliest = current - RING_CAP + 1
    if (since >= earliest - 1) return { kind: 'hello-only' }
    return { kind: 'hello-gap', droppedFrom: since + 1, droppedTo: current - RING_CAP }
  }

  subscriberCount(): number {
    return this.subscribers.size
  }

  addSubscriber(ws: WebSocket): Subscriber {
    const sub: Subscriber = { ws, paused: false, drainLoopCount: 0, lastDeliveredSeq: 0 }
    this.subscribers.add(sub)
    ws.once('close', () => this.subscribers.delete(sub))
    return sub
  }

  broadcast(frame: { type: string; payload: unknown }): void {
    const seq = this.mintSeq()
    this.recordFrame({ seq, type: frame.type })
    const serialized = JSON.stringify({ ...frame, seq })
    for (const sub of this.subscribers) this.sendToSubscriber(sub, serialized, seq)
  }

  private sendToSubscriber(sub: Subscriber, msg: string, seq: number): void {
    if (sub.paused) return
    if (sub.ws.bufferedAmount > HARD_WATERMARK_BYTES) {
      sub.ws.close(4429, 'backpressure hard watermark')
      return
    }
    sub.ws.send(msg, (err) => {
      if (err) sub.ws.close(1011, 'send error')
    })
    // Check bufferedAmount after send to detect backpressure.
    if (sub.ws.bufferedAmount > 0) {
      sub.paused = true
      sub.ws.once('drain', () => this.onDrain(sub))
    } else {
      sub.lastDeliveredSeq = seq
      sub.drainLoopCount = 0
    }
  }

  private onDrain(sub: Subscriber): void {
    if (sub.ws.bufferedAmount >= 256 * 1024) return
    sub.paused = false
    sub.drainLoopCount++
    if (sub.drainLoopCount >= DRAIN_LOOP_LIMIT) {
      sub.ws.close(4429, 'drain loop limit')
      return
    }
    // TODO post-drain hello rebroadcast so ext fetches a fresh snapshot.
  }
}
