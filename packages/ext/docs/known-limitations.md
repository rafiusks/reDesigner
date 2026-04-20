<!-- human -->
# reDesigner Extension — Known Limitations (v0)

This document lists the known functional boundaries and gaps in v0. Each entry includes the current behavior, the reason for the limitation, and the planned resolution target.

---

## 1. Iframe Contents Out of Scope

**Behavior:** When the user activates the element picker over an `<iframe>`, `document.elementsFromPoint()` does not descend into the iframe's document. The picker resolves to the `<iframe>` element itself in the host document, not the element visually under the cursor inside the frame.

**Reason:** Content scripts run in the main frame's document context by default (`all_frames: false` in v0 manifest). Crossing into an iframe's browsing context requires either injecting the content script into sub-frames or using `chrome.scripting.executeScript` with `allFrames: true`, which requires the iframe's origin to be in `host_permissions`.

**Workaround:** Open the iframe's `src` URL in a new tab and use the picker there.

**Fix target:** v0.1 — add `all_frames: true` to the content-script entry and implement a sub-frame picker registration path.

---

## 2. Keyboard Pick Not Supported in v0

**Behavior:** Activating picker mode (via keyboard shortcut or toolbar icon) enters a click-to-pick mode. There is no keyboard-driven element traversal (Tab / arrow key focus navigation to select an element without clicking).

**Reason:** The v0 picker armed from `src/content/picker.ts` listens to `mousemove` and `click` only. No `keydown` listener for focus-based traversal was implemented.

**Workaround:** Use the mouse to click the target element after arming the picker.

**Fix target:** v0.1 — add keyboard traversal (Tab / Shift+Tab cycles through focusable elements; arrow keys traverse DOM siblings; Enter commits selection).

---

## 3. Incognito Backfill May Be Blocked

**Behavior:** On extension install, the service worker's `chrome.runtime.onInstalled` handler calls `chrome.scripting.executeScript` to inject the content script into all currently open matching tabs (backfill). This call may silently fail for tabs in incognito windows if the user has not explicitly enabled "Allow in incognito" for the extension.

**Reason:** `chrome.scripting.executeScript` on incognito tabs requires the extension to be allowed in incognito mode (`incognitoAllowance` must be `'allowed'`). This permission is user-granted and cannot be requested programmatically.

**Workaround:** After installation, if the active tab is in an incognito window, manually reload the tab to inject the content script. Alternatively, enable "Allow in incognito" in `chrome://extensions` for reDesigner.

**Fix target:** v0.1 — surface a one-time notification to the user if backfill injection fails on an incognito tab, prompting them to enable incognito access.

---

## 4. Closed Shadow Roots Are Opaque

**Behavior:** The picker and the element inspection path cannot see inside a `ShadowRoot` created with `{ mode: 'closed' }`. Picking on a host element that has a closed shadow root resolves to the shadow host in the light DOM; internal shadow tree nodes are invisible.

**Reason:** Closed shadow roots explicitly deny external access to `shadowRoot`. `document.elementsFromPoint()` and `element.shadowRoot` both return `null` for closed roots. There is no API-level workaround without patching the page's `Element.prototype.attachShadow`, which is an integrity violation.

**Workaround:** None in v0. If the target component exposes a `mode: 'open'` option, switch to open mode during development.

**Fix target:** v1 consideration — document-level `attachShadow` patching is controversial; will be gated on an opt-in developer preference.

---

## 5. Cross-Origin Iframes Fully Excluded

**Behavior:** Even if `all_frames: true` were enabled (see limitation 1), content scripts cannot run in cross-origin iframes unless the iframe's origin is explicitly listed in `host_permissions`. v0 uses `http://localhost/*` host permission only, so any `<iframe src="https://...">` is out of scope.

**Reason:** Chrome's extension permission model requires `host_permissions` to cover the iframe's origin for the content script to be injected into that frame's context.

**Workaround:** Not applicable in typical dev workflows — localhost dev servers rarely embed cross-origin iframes in a way that requires design inspection.

**Fix target:** Not planned. Cross-origin iframe inspection is a fundamentally different privilege scope and would require user-visible permission grants for each iframe origin.

---

## 6. HTTP Only — No HTTPS Localhost Support in v0

**Behavior:** The daemon listens on plain HTTP (`http://localhost:<port>`). The Vite plugin's `transformIndexHtml` fetches the bootstrap token over HTTP. If the developer's Vite dev server is configured with HTTPS (e.g., `vite --https` or a custom `server.https` config), the mixed-content policy in browsers blocks the plain-HTTP daemon connection from an HTTPS page.

**Reason:** Generating a trusted-CA TLS certificate for localhost is non-trivial to automate without developer interaction. v0 defers this to avoid requiring users to install a local CA or manage self-signed certificates.

**Workaround:** Run the Vite dev server over plain HTTP during development with reDesigner. For projects that require HTTPS dev, use a reverse proxy that terminates TLS and forwards plain HTTP to both the Vite server and the daemon port.

**Fix target:** v0.1 — integrate [`@vitejs/plugin-basic-ssl`](https://github.com/vitejs/vite-plugin-basic-ssl) or mkcert-based local CA automation into the daemon's bind path so the WebSocket upgrade uses `wss://` from an HTTPS page.

---

## 7. Single Active Session per Daemon Instance

**Behavior:** The daemon supports one active extension session at a time. If two browser profiles (or two browser windows with different extension instances) attempt to connect to the same daemon, the second connection is rejected at the TOFU ext-ID pinning layer.

**Reason:** The TOFU model pins the first connecting extension ID. Multi-session support would require either relaxing TOFU to a whitelist or adding a session-multiplexing layer.

**Workaround:** Use one browser profile per daemon instance. Stop the first session before starting a second.

**Fix target:** v0.1 — introduce an explicit allowlist replacing TOFU once Web-Store ext-ID binding ships, allowing multiple pinned IDs.
