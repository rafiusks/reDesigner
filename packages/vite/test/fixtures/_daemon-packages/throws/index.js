// Package whose import throws synchronously during evaluation.
// Exercises DaemonBridge's "generic importer error" path: no ERR_MODULE_NOT_FOUND /
// ERR_PACKAGE_PATH_NOT_EXPORTED code, so the bridge warns (auto) or falls through.
throw new Error('simulated daemon package bootstrap failure')
