Daemon-local gotchas for contributors.
Never add a second process.on('message', ...) listener outside src/child.ts. The IPC channel is unref'd at boot so disconnect-driven shutdown doesn't block on channel refs; a new message listener re-refs it and silently reverts this.
AbortSignal.timeout (not new AbortController) for all fetch timeouts — undici#2198 leak.
All Zod schemas at module top-level; in-handler z.object() is a 100x Zod v4 regression cliff.
fs.watch on macOS is not reliable; ManifestWatcher compensates via 3s stat-poll. Do not remove.
perMessageDeflate: false on WebSocketServer — CRIME/BREACH + zip-bomb defense. Do not enable.
