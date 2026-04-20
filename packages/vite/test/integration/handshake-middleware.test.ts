/**
 * End-to-end integration test for the /__redesigner/handshake.json middleware.
 *
 * Boots a real Vite dev server (NOT middlewareMode — we need a listening HTTP
 * server so the Host header authority check has a real port to compare to),
 * exercises the handshake route over TCP, and verifies:
 *   - The middleware mounts correctly onto Vite's connect stack.
 *   - Requests short-circuit before Vite's SPA fallback runs.
 *   - Degraded response (503) fires when the daemon package is absent.
 *
 * The daemon package is NOT installed in this workspace's vitest runtime path
 * (ERR_MODULE_NOT_FOUND in auto mode — matches production "manifest-only" mode),
 * so the handshake middleware's daemon accessor returns null and we exercise
 * the 503 `extension-disconnected` branch without spinning up a real daemon.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ViteDevServer, createServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import redesigner from '../../src/index'

const PKG_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..')
const REACT_DIR = path.join(PKG_ROOT, 'node_modules/react')
const REACT_DOM_DIR = path.join(PKG_ROOT, 'node_modules/react-dom')

describe('vite integration: /__redesigner/handshake.json middleware', () => {
  let dir: string
  let server: ViteDevServer
  let baseUrl: string

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'redesigner-handshake-')))
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'handshake-int', type: 'module', version: '0.0.0', private: true }),
    )

    server = await createServer({
      root: dir,
      configFile: false,
      plugins: [redesigner()],
      esbuild: { jsx: 'automatic' },
      // Real listening server with port 0 so Node picks a free one.
      server: { port: 0, strictPort: false, host: '127.0.0.1', fs: { strict: false } },
      resolve: {
        alias: {
          'react/jsx-dev-runtime': path.join(REACT_DIR, 'jsx-dev-runtime.js'),
          'react/jsx-runtime': path.join(REACT_DIR, 'jsx-runtime.js'),
          'react-dom/client': path.join(REACT_DOM_DIR, 'client.js'),
          'react-dom': path.join(REACT_DOM_DIR, 'index.js'),
          react: path.join(REACT_DIR, 'index.js'),
        },
      },
      clearScreen: false,
    })
    await server.listen()
    const addr = server.httpServer?.address()
    if (!addr || typeof addr !== 'object') throw new Error('no server address')
    baseUrl = `http://127.0.0.1:${addr.port}`
  }, 15000)

  afterAll(async () => {
    await server?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('daemon absent → 503 with apiErrorCode=extension-disconnected (middleware is mounted + gating passes)', async () => {
    const res = await fetch(`${baseUrl}/__redesigner/handshake.json`, {
      method: 'GET',
      headers: {
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Site': 'none',
      },
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { apiErrorCode: string }
    expect(body.apiErrorCode).toBe('extension-disconnected')
    expect(res.headers.get('cache-control')).toBe('no-store, private')
  }, 10000)

  it('bad fetch-metadata → 403 host-rejected (gating fires before daemon check)', async () => {
    const res = await fetch(`${baseUrl}/__redesigner/handshake.json`, {
      method: 'GET',
      headers: {
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Site': 'none',
      },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { apiErrorCode: string }
    expect(body.apiErrorCode).toBe('host-rejected')
  }, 10000)

  it('POST → 405 with Allow: GET', async () => {
    const res = await fetch(`${baseUrl}/__redesigner/handshake.json`, {
      method: 'POST',
      headers: { 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Site': 'none' },
    })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET')
  }, 10000)
})
