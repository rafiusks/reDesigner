<!-- human -->
# reDesigner Extension Dogfood Checklist

This guide walks through picking an element in the reDesigner playground with
the Chrome extension and verifying the result via the MCP shim from Claude Code.

## Prerequisites

- Node ≥ 22, pnpm ≥ 9.15
- Chrome 120+
- Claude Code CLI installed (`claude --version`)
- reDesigner repo cloned and `pnpm install` run from root

## Steps

### 1. Build the extension

```bash
pnpm --filter @redesigner/ext build
```

Expected: `packages/ext/dist/` populated with `manifest.json`,
`service-worker-loader.js` (the CRXJS-generated SW entry), per-panel chunks
under `assets/`, icon PNGs, and `src/panel/index.html`.

### 2. Load the extension in Chrome

- Navigate to `chrome://extensions`
- Enable **Developer mode** (toggle, top right)
- Click **Load unpacked**
- Select `packages/ext/dist/`

Expected: extension appears with name **reDesigner**, a generated extension ID is
shown. Pin it to the toolbar for easy access.

### 3. Start the playground dev server

```bash
pnpm --filter @redesigner/playground dev
```

Expected: Vite starts on `http://localhost:5173` (or the next free port). The
`@redesigner/vite` plugin calls `child_process.fork` to spawn the daemon. The
daemon's stdout ready line is consumed internally by the bridge, so the
terminal only shows the vite banner. Confirm the daemon actually started by
either:

- Tailing `examples/playground/.redesigner/daemon.log`. Success looks like:
  ```json
  {"ts":<unix-ms>,"level":"info","msg":"[daemon] ready","pid":<N>,"port":<N>,"instanceId":"<uuid>","handoffPath":"..."}
  ```
- Or checking the handoff file (next block).

The handoff file is written at
`$TMPDIR/com.redesigner.<uid>/<projectHash>/daemon-v1.json` on macOS
(`$XDG_RUNTIME_DIR/redesigner/<projectHash>/daemon-v1.json` on Linux,
`%LOCALAPPDATA%\redesigner\<uid>\<projectHash>\daemon-v1.json` on Windows) and
contains the port and bearer token as JSON fields.

Verify the daemon is live:

```bash
# Locate the handoff file (platform-specific runtime dir) and extract
# port + token from its JSON payload.
case "$(uname -s)" in
  Darwin) ROOT="$TMPDIR/com.redesigner.$(id -u)" ;;
  Linux)  ROOT="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/redesigner" ;;
  *)      ROOT="$LOCALAPPDATA/redesigner" ;;  # Windows (use $env:LOCALAPPDATA in PowerShell)
esac
HANDOFF=$(find "$ROOT" -name 'daemon-v1.json' 2>/dev/null | head -1)
PORT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$HANDOFF','utf8')).port)")
TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$HANDOFF','utf8')).token)")
curl -s "http://localhost:$PORT/health" -H "Authorization: Bearer $TOKEN"
```

Expected output:

```json
{"ok":true}
```

### 4. Register the MCP shim with Claude Code

First build the MCP server so `packages/mcp/dist/cli.js` exists:

```bash
pnpm --filter @redesigner/mcp build
```

Then register it with Claude Code. Replace `$REPO_ROOT` with the absolute path
to your reDesigner checkout (the `--` stdio transport requires an absolute path,
not a pnpm workspace reference):

```bash
claude mcp add --transport stdio redesigner -- \
  node $REPO_ROOT/packages/mcp/dist/cli.js
```

Restart Claude Code (or open a new session) so the new server is picked up.

Verify registration:

```bash
claude mcp list
```

Expected: `redesigner` appears in the list with status `connected`.

### 5. Arm the picker

Open `http://localhost:5173` in Chrome. Press **Alt+Shift+D** (the default chord
declared in `manifest.json` under `commands["arm-picker"]`).

Expected:
- Toolbar icon switches to the "armed" variant (different badge colour).
- A hover-highlight outline appears over the nearest instrumented element as you
  move the mouse.
- DevTools → Console shows the SW dispatching `arm-picker` to the content script.

### 6. Pick an element

Click any `<Button>` on the playground page. The picker commits the target.

Expected: the extension sends:

```
PUT http://localhost:<port>/tabs/<tabId>/selection
```

with body (shape per `SelectionPutBodySchema` in `@redesigner/core`):

```json
{
  "clientId": "<uuidv4>",
  "nodes": [
    {
      "id": "<opaque-1-128-char-id>",
      "componentName": "Button",
      "filePath": "examples/playground/src/components/Button.tsx",
      "lineRange": [1, 10],
      "domPath": "body > div > button",
      "parentChain": ["App", "Page"],
      "timestamp": 1681234567890
    }
  ],
  "meta": { "source": "picker" }
}
```

(`meta` is optional; `lineRange` is `[start, end]` of 1-based line numbers.)

Response body:

```json
{"selectionSeq":1,"acceptedAt":1681234567890}
```

The side panel updates and shows the selected component with a "Claude Code can
see this" status pip.

### 7. Ask Claude Code

In a Claude Code chat session (after the MCP shim is connected), ask:

> what's my current selection?

Expected: the MCP shim calls `GET /selection` on the daemon and returns the
`ComponentHandle`. Example response:

```
Current selection:
- Component: <Button>
- File: examples/playground/src/components/Button.tsx:1:0
- Range: lines 1–10
```

The `filePath` value must be a repo-relative path and include a line reference
(`filePath:line:col`). If only a displayName is returned and no filePath, the
manifest was not built or the daemon received a stale manifest — see
Troubleshooting below.

## Troubleshooting

**No handshake banner / extension cannot reach daemon**
Verify `<meta name="redesigner-daemon">` is injected by the Vite plugin. Check
DevTools → Elements → `<head>`. If absent, confirm `@redesigner/vite` is
registered in `examples/playground/vite.config.ts`.

**Panel says "mcp-missing"**
The daemon is up but no MCP client is connected. Run `claude mcp list` and
confirm `redesigner` shows as `connected`. Restart Claude Code after adding the
server.

**`/health` returns 401**
The Authorization header is missing or uses the wrong token. Read the `token`
field from the `daemon-v1.json` handoff file (see step 3) and pass it as
`Bearer <token>`.

**Shortcut not firing**
Open `chrome://extensions/shortcuts` and confirm a key is bound to
"reDesigner: Arm picker". Chrome only allows one extension to own a given chord
— reassign if there is a conflict.

**`selectionSeq` never increments**
The PUT body failed schema validation. Open DevTools → Network, find the PUT to
`/tabs/.../selection`, inspect the 400 response for the `detail` field.

## Next steps

After a successful first run, copy the anonymised terminal + DevTools output
into `examples/playground/EXT_DOGFOOD_LOG.md` and commit it. That file is not
shipped in v0.

## Token-sync dogfood (T8) — exchange → session → SelectionCard

These steps verify the full daemon↔vite token-sync flow introduced in the
fix/daemon-vite-token-sync branch. They assume you have completed steps 1–3
above (extension built, loaded, playground running).

### 1. Start the playground (daemon forks automatically)

```bash
pnpm --filter @redesigner/vite dev
```

The `@redesigner/vite` plugin forks the daemon and writes
`bootstrapToken` into the handshake middleware at
`/__redesigner/handshake.json`. The daemon also writes its full handoff file
(port + rootToken) under the OS runtime dir as usual.

### 2. Load the built extension

- Navigate to `chrome://extensions`
- Enable **Developer mode**
- Click **Load unpacked** → select `packages/ext/dist/`

### 3. Open the playground and the side panel

Open `http://localhost:5173/` in Chrome. Click the reDesigner toolbar icon to
open the side panel (or right-click → "Open side panel" if available in your
Chrome build).

Expected: the Welcome section reads **"Detected: http://localhost:5173 — open?"**.
This means the SW completed the bootstrap→exchange handshake and the daemon
accepted the minted session token.

### 4. Arm the picker

Press **Alt+Shift+D** (the `arm-picker` command from `manifest.json`).

Expected:
- Toolbar icon updates to the "armed" badge variant.
- Hovering over the page shows a pick highlight outline on instrumented elements.
- SW DevTools console shows `[redesigner:sw] arm-picker dispatched`.

### 5. Click a component

Hover over the pricing section and click. Any element with a
`data-redesigner-loc` attribute is a valid target (the vite plugin injects
these during dev).

Expected:
- The side panel transitions from Welcome to **SelectionCard**.
- SelectionCard shows:
  - Green pip: **"Claude Code can see this"**
  - Component name (e.g. `PricingCard`)
  - File path + line (e.g. `src/components/PricingCard.tsx:3`)
- SW DevTools console shows `[redesigner:sw] selection pushed` with **no 401**.

### 6. Verify network calls

Open **DevTools → Network** tab (filter by XHR/Fetch):

| Call | Expected status |
|---|---|
| `POST /__redesigner/exchange` | 200 |
| `GET /manifest` (daemon port) | 200 |
| `PUT /tabs/<tabId>/selection` (daemon port) | 200 |

All three must complete without 401 errors. A 401 on `GET /manifest` means
the session token was not forwarded correctly from exchange; a 401 on `PUT`
means the session bearer was not accepted by the daemon's REST auth chain.

### 7. Automated nightly spec

The same flow is covered by the Playwright nightly spec at
`packages/ext/test/e2e/nightly/exchange-live.spec.ts`. To run it with a full
harness:

```bash
PW_FULL_HARNESS=1 pnpm --filter @redesigner/ext test:e2e
```

The spec exercises exchange, session bearer on GET /manifest, and a synthetic
PUT /tabs/:tabId/selection + GET /selection round-trip. True click-through UI
automation (keyboard chord → overlay → SelectionCard renders) is tracked as a
post-v0 follow-up.
