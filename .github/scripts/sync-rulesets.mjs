#!/usr/bin/env node
// Syncs committed ruleset JSON to GitHub via REST.
// Usage: node sync-rulesets.mjs --mode=sync|drift-check
// Requires: GH_TOKEN env (PAT with repo scope; GITHUB_TOKEN cannot modify rulesets).

import { readFile, readdir } from 'node:fs/promises'
import { argv, env, exit } from 'node:process'

const mode = argv.find((a) => a.startsWith('--mode='))?.slice(7) || 'sync'
if (!['sync', 'drift-check'].includes(mode)) {
  console.error(`unknown --mode=${mode}`)
  exit(2)
}

const repo = env.GITHUB_REPOSITORY
if (!repo) {
  console.error('GITHUB_REPOSITORY unset')
  exit(2)
}
const token = env.GH_TOKEN
if (!token) {
  console.error('GH_TOKEN unset (need PAT with repo scope)')
  exit(2)
}

const api = (path, init = {}) =>
  fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })

const rulesetFiles = (await readdir('.github/rulesets')).filter((f) => f.endsWith('.json'))
let failed = false

for (const file of rulesetFiles) {
  const committed = JSON.parse(await readFile(`.github/rulesets/${file}`, 'utf8'))

  // List existing rulesets; match by name.
  const listRes = await api(`/repos/${repo}/rulesets`)
  if (!listRes.ok) {
    console.error(`list rulesets failed: ${listRes.status}`)
    exit(1)
  }
  const existing = (await listRes.json()).find((r) => r.name === committed.name)

  if (mode === 'drift-check') {
    if (!existing) {
      console.error(`drift: ${committed.name} not present on server`)
      failed = true
      continue
    }
    // Fetch full ruleset (list endpoint omits rules details).
    const fullRes = await api(`/repos/${repo}/rulesets/${existing.id}`)
    if (!fullRes.ok) {
      console.error(`fetch ${existing.id} failed: ${fullRes.status}`)
      failed = true
      continue
    }
    const live = await fullRes.json()
    const {
      id: _id,
      node_id: _nid,
      source: _src,
      source_type: _st,
      _links,
      created_at: _ca,
      updated_at: _ua,
      ...liveCmp
    } = live
    if (JSON.stringify(liveCmp) !== JSON.stringify(committed)) {
      console.error(`drift: ${committed.name} differs from committed JSON`)
      console.error(
        `diff (committed vs live): run \`gh api /repos/${repo}/rulesets/${existing.id}\` and compare`,
      )
      failed = true
    } else {
      console.log(`ok: ${committed.name}`)
    }
    continue
  }

  // mode === 'sync'
  if (existing) {
    const res = await api(`/repos/${repo}/rulesets/${existing.id}`, {
      method: 'PUT',
      body: JSON.stringify(committed),
    })
    if (!res.ok) {
      console.error(`PUT ${existing.id} failed: ${res.status} ${await res.text()}`)
      exit(1)
    }
    console.log(`updated: ${committed.name} (id ${existing.id})`)
  } else {
    const res = await api(`/repos/${repo}/rulesets`, {
      method: 'POST',
      body: JSON.stringify(committed),
    })
    if (!res.ok) {
      console.error(`POST failed: ${res.status} ${await res.text()}`)
      exit(1)
    }
    const { id } = await res.json()
    console.log(`created: ${committed.name} (id ${id})`)
  }
}

if (failed) exit(1)
