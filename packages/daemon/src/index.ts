import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export interface DaemonHandle {
  pid: number
  shutdown: () => Promise<void>
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  stdin: NodeJS.WritableStream
}

export interface StartDaemonOptions {
  manifestPath: string
}

const READY_TIMEOUT_MS = process.platform === 'win32' ? 10_000 : 2_000

export async function startDaemon(opts: StartDaemonOptions): Promise<DaemonHandle> {
  const childEntry = fileURLToPath(new URL('./child.js', import.meta.url))
  const child: ChildProcess = fork(childEntry, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      REDESIGNER_MANIFEST_PATH: opts.manifestPath,
      REDESIGNER_BRIDGE_PID: String(process.pid),
    },
  })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon ready-line timeout')), READY_TIMEOUT_MS)
    let buffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line)
          if (parsed.type === 'ready') {
            clearTimeout(timer)
            resolve()
            return
          }
        } catch {
          // ignore non-JSON stdout (logger output may land here)
        }
      }
    })
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`daemon exited before ready (code=${code})`)))
  })

  if (child.pid == null || child.stdout == null || child.stderr == null || child.stdin == null) {
    throw new Error('daemon child process missing required stdio handles')
  }

  const pid = child.pid
  const stdout = child.stdout as NodeJS.ReadableStream
  const stderr = child.stderr as NodeJS.ReadableStream
  const stdin = child.stdin as NodeJS.WritableStream

  return {
    pid,
    stdout,
    stderr,
    stdin,
    shutdown: async () => {
      // IPC disconnect triggers process.on('disconnect') in child → graceful shutdown (§4)
      child.disconnect()
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve()
        } else {
          child.once('exit', () => resolve())
        }
      })
    },
  }
}
