// Package that imports fine but does not export `startDaemon`.
// The bridge awaits `mod.startDaemon(...)`; calling undefined throws TypeError.
export const unrelated = 'present'
// No startDaemon export.
