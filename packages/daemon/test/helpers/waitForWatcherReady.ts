import fs from 'node:fs'
import path from 'node:path'

export async function waitForWatcherReady(
  watchDir: string,
  timeoutMs = 500,
  maxRetries = 3,
): Promise<void> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const sentinel = path.join(watchDir, `.watcher-ready-${Date.now()}-${attempt}`)
    const ready = new Promise<void>((resolve, reject) => {
      const w = fs.watch(watchDir, (_, filename) => {
        if (filename === path.basename(sentinel)) {
          w.close()
          resolve()
        }
      })
      setTimeout(() => {
        w.close()
        reject(new Error('watcher-ready sentinel timed out'))
      }, timeoutMs).unref()
    })
    fs.writeFileSync(sentinel, '')
    try {
      await ready
      fs.unlinkSync(sentinel)
      return
    } catch {}
    try {
      fs.unlinkSync(sentinel)
    } catch {}
  }
  throw new Error('waitForWatcherReady: no sentinel event after retries')
}
