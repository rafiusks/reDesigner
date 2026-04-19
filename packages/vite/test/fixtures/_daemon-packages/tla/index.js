// Package whose top-level-await blocks forever.
// DaemonBridge uses Promise.race against a 2s timer to avoid hanging.
// Per spec, the underlying TLA import is NOT truly aborted (Node dynamic import is
// not cancellable), so this test MUST run in its own forked worker. The pending
// import will leak until the worker dies — that is why the dedicated config uses
// pool=forks, isolate=true, fileParallelism=false.
await new Promise(() => {}) // hangs forever
export const startDaemon = async () => null
