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

Expected: `packages/ext/dist/` populated with `manifest.json`, `src/sw/index.js`,
content scripts, and panel assets.

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
plugin prefixes all daemon stdout with `[daemon] ` and the daemon emits a
structured JSON ready line, so look for something like:

```
[daemon] {"type":"ready","port":<N>,"instanceId":"<uuid>"}
```

The handoff file is written at
`$TMPDIR/com.redesigner.<uid>/<projectHash>/daemon-v1.json` on macOS
(`$XDG_RUNTIME_DIR/redesigner/<projectHash>/daemon-v1.json` on Linux,
`%LOCALAPPDATA%\redesigner\<uid>\<projectHash>\daemon-v1.json` on Windows) and
contains the port and bearer token as JSON fields.

Verify the daemon is live:

```bash
# Locate the handoff file and extract port + token from its JSON payload.
HANDOFF=$(find "$TMPDIR" -name 'daemon-v1.json' 2>/dev/null | head -1)
PORT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$HANDOFF','utf8')).port)")
TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$HANDOFF','utf8')).token)")
curl -s "http://localhost:$PORT/health" -H "Authorization: Bearer $TOKEN"
```

Expected output:

```json
{ "ok": true }
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

with body:

```json
{
  "nodes": [
    {
      "displayName": "Button",
      "filePath": "examples/playground/src/components/Button.tsx",
      "lineRange": [1, 10],
      "columnRange": [0, 0]
    }
  ]
}
```

Response body:

```json
{ "selectionSeq": 1, "acceptedAt": 1681234567890 }
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
