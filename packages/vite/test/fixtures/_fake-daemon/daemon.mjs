#!/usr/bin/env node
// Fake daemon used by test/integration/shutdown.test.ts (task E-16).
// Spawned as `node daemon.mjs <mode>`; writes `{"ready":true}` on start,
// then behaves per mode:
//   clean           — listens for SIGTERM and exits 0.
//   ignore-sigterm  — traps SIGTERM and does nothing (forces SIGKILL escalation).
//   windows-ack     — line-delimited JSON on stdin; on {"op":"shutdown"}
//                     writes {"ack":true}\n and exits shortly after.
//   windows-no-ack  — ignores stdin entirely (exercises taskkill fallback).
const mode = process.argv[2] || 'clean'

process.stdout.write('{"ready":true}\n')

if (mode === 'clean') {
  process.on('SIGTERM', () => process.exit(0))
}

if (mode === 'ignore-sigterm') {
  // Trap SIGTERM with a no-op so the OS default terminate is suppressed.
  process.on('SIGTERM', () => {})
}

if (mode === 'windows-ack') {
  let buf = ''
  process.stdin.on('data', (chunk) => {
    buf += chunk.toString()
    let idx = buf.indexOf('\n')
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line) {
        try {
          const msg = JSON.parse(line)
          if (msg.op === 'shutdown') {
            process.stdout.write('{"ack":true}\n')
            setTimeout(() => process.exit(0), 100)
          }
        } catch {}
      }
      idx = buf.indexOf('\n')
    }
  })
}

if (mode === 'windows-no-ack') {
  // Intentionally do nothing with stdin. Bridge ack-timer fires at 1.5s and
  // the bridge escalates to taskkill. A spy-spawn in the test records that.
}

// Prevent early exit for modes that need to keep the event loop alive.
setInterval(() => {}, 60_000)
