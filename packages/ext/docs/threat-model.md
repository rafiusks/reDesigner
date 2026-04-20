<!-- human -->
# reDesigner Extension — Threat Model (v0)

## 1. Scope

This document covers what the reDesigner Chrome extension actively defends, what has been deliberately accepted as residual risk in v0, and what is explicitly out of scope.

**In scope for this model:**

- The session token (issued by the daemon's bootstrap endpoint and used to authenticate WebSocket connections).
- Selection data (element paths and design props forwarded from content script to the panel via the service worker).
- The extension's own internal state (manifest cache, RPC call queue, port lifecycle).

**Out of scope:**

- The host web application's own authentication or secrets (we cannot protect what the page already exposes to page scripts).
- Malicious user-installed extensions that have DevTools-level access to the browser — a compromised browser host invalidates all local security assumptions.
- Physical access to the developer's machine.

---

## 2. Assets and Trust Boundaries

| Asset | Location | Trust zone |
|---|---|---|
| Bootstrap session token | Daemon HTTP response header (`X-ReDesigner-Token`) + injected meta tag in `index.html` | Daemon origin; kernel boundary at localhost |
| WebSocket subprotocol bearer | `Sec-WebSocket-Protocol: redesigner-v1, base64url.bearer.authorization.redesigner.dev.<token>` header on upgrade | Wire between extension and daemon |
| Selection payload | content script → SW → panel via `chrome.runtime.sendMessage` | Extension process boundary |
| Manifest cache | `chrome.storage.session` in TRUSTED_CONTEXTS | Extension storage; isolated from page |
| Extension ID | Derived from `manifest.json` `key` field; stable across unpacked reloads | Chrome profile |

---

## 3. Threat Actors

### 3.1 Page-embedded attacker (same-origin script)

A script running at the same origin as the app (first-party, third-party bundle, ad script, or XSS payload) can read the DOM and `<meta>` tags that `transformIndexHtml` injects. It therefore has read access to the bootstrap token in the DOM.

It cannot read `chrome.storage.session` (isolated to the extension's service worker), cannot forge the HMAC signature, and cannot directly upgrade a WebSocket with an arbitrary subprotocol without going through the daemon's host allowlist.

### 3.2 Co-installed localhost-permissioned extension

Another user-installed Chrome extension holding `http://localhost/*` permission can make fetch requests to the daemon's bootstrap and token endpoints in the same browser session. In v0, the daemon trusts any extension on localhost that presents a valid bootstrap token. A co-installed extension could, in theory, mint its own session.

**v0.1 fix:** Web-Store ext-ID binding — daemon verifies that requests include the expected extension's `externally_connectable` ID, rejecting unknown callers.

### 3.3 Local network attacker (same LAN)

An attacker on the same LAN as the developer's machine who can observe or inject traffic on the loopback interface (e.g., via port scan or ARP poisoning to 127.0.0.1 — unusual but theoretically possible on some VPN topologies). The daemon's host literal-set allowlist and `Sec-Fetch-Site` compound predicate defend against DNS rebinding, but a true loopback eavesdropper is a physical-compromise scenario, not a software one.

### 3.4 Reverse-proxy operator

If the developer routes their local dev server through a logging reverse proxy (e.g., Charles, mitmproxy, or a corporate MITM TLS inspector), the `Sec-WebSocket-Protocol` upgrade header may be captured in proxy logs. The session token is carried in that header.

This is documented but not fixed in v0. Mitigation would require a secondary out-of-band token exchange.

### 3.5 DevTools inspector

Anyone with DevTools open on the page or the extension's service worker can observe the WebSocket upgrade handshake including the `Sec-WebSocket-Protocol` header containing the session token. This gives full session access.

This is accepted in v0: DevTools access implies local machine access. The threat actor with DevTools open also has `chrome.storage.session` read access, so no meaningful security boundary exists.

### 3.6 Third-party inline scripts

The app's page may load untrusted third-party scripts (analytics, CDN widgets, A/B testing) at the same origin. These scripts can read the injected bootstrap meta tag from the DOM and extract the session token.

The developer is responsible for the trust level of scripts they run at their app's origin. Mitigation (body removal after read) is not applied in v0; the header is canonical and body is kept for compatibility.

---

## 4. Mitigations Applied in v0

### 4.1 Bootstrap token in response header

The daemon issues the session token as an HTTP response header (`X-ReDesigner-Token`) on the bootstrap endpoint. The Vite plugin's `transformIndexHtml` reads this header server-side and injects it into a `<meta>` tag. The header-path is authoritative; page scripts that observe the meta tag get read access, but there is no secondary `Set-Cookie` or URL leakage path.

### 4.2 Session token in `storage.session` — content script cannot read

Once the service worker receives the session token, it stores it in `chrome.storage.session` with `TRUSTED_CONTEXTS` access restriction. Content scripts run in a separate context and cannot read this key, preventing a page-injected script that compromises the content script from elevating to session access.

### 4.3 Randomized session key name per boot

The storage key is `s_<uuid>` generated fresh at daemon start. An observer who can enumerate `chrome.storage.session` keys (e.g., the DevTools Storage panel) sees a random key name that changes every daemon restart. This prevents a cached key name from being a persistent oracle.

### 4.4 Host literal-set allowlist + `Sec-Fetch-Site` compound predicate

The daemon validates both: (a) the request Origin is in the extension's literal ID set, and (b) `Sec-Fetch-Site` is either `cross-site` (the value Chrome sends for `chrome-extension://`-to-`localhost` fetches) or `none` (header absent, e.g. some service-worker-originated or non-browser clients). This compound predicate blocks DNS-rebind attacks where a page at an evil domain tricks the browser into sending ambient credentials to localhost: a rebind victim cannot forge `Sec-Fetch-Site: cross-site` from a page context, because a page running on the rebinded hostname will have the browser stamp `same-origin` or `same-site` on its requests to that same host.

### 4.5 Subprotocol bearer — not a page cookie

The session token is carried in the WebSocket `Sec-WebSocket-Protocol` offer as a k8s-style bearer entry (`base64url.bearer.authorization.redesigner.dev.<token>`), alongside a version-negotiation subprotocol (`redesigner-v1`) — i.e. the client offers `['redesigner-v1', 'base64url.bearer.authorization.redesigner.dev.<token>']`. The token is not carried as an HTTP cookie or URL query parameter. This means:

- Page-level scripts cannot set or read the subprotocol without going through the extension's runtime message channel (isolated from page context).
- Standard CSRF patterns that abuse `SameSite=Lax` cookies do not apply.
- The token does not appear in browser history or bookmarks.

### 4.6 HMAC session token + `serverNonceEcho` verification

Three distinct checks compose to give replay resistance:

- **Exchange-time HMAC (daemon `/exchange`):** the extension sends an HMAC-signed request (over `clientNonce || serverNonce || iatBE8`) to `/exchange`, and on successful verification the daemon mints a session token bound to that nonce epoch. The HMAC is checked at this HTTP POST only, not on every WS upgrade.
- **WS upgrade bearer check (daemon `ws/events.ts`):** the WebSocket upgrade handler does not re-verify the HMAC. It extracts the bearer from the `Sec-WebSocket-Protocol` offer and runs `compareToken` against the active session token minted by the most recent `/exchange`. A stale token from a previous session fails this comparison.
- **`serverNonceEcho` (SW-side check):** the daemon's first `hello` frame echoes the `serverNonce` that was returned by the `/exchange` response which minted the current session. The service worker verifies this echo against the nonce it remembers from that exchange; a mismatch means the exchange response was replayed or the daemon does not hold the session the SW thinks it does, and the WS is aborted. This is a client-side check, not a daemon-side one.

### 4.7 TOFU ext-ID pinning

The daemon records the first extension ID that contacts it on first boot (Trust-On-First-Use). Subsequent connections from a different extension ID are rejected with a warning logged to the daemon's stderr. This does not prevent a co-installed extension from being the first caller, but it constrains the attack window to the brief period before the first legitimate connection.

### 4.8 CORS `Vary: Origin, Access-Control-Request-Headers`

All daemon HTTP responses include `Vary: Origin, Access-Control-Request-Headers`. This prevents shared preflight cache poisoning where a cached OPTIONS response for one origin is served for another, potentially allowing cross-origin reads.

---

## 5. Accepted Residuals in v0

The following risks are understood, documented, and accepted for v0. Each has a proposed fix tracked for v0.1 unless otherwise noted.

### 5.1 Bootstrap token readable from DOM

The `<meta name="redesigner-token">` tag is readable by any script running at the app's origin after `transformIndexHtml` runs. The header-canonical design ensures this is a copy, not the primary credential, but an attacker with same-origin script execution can extract it.

**Accepted because:** the developer controls their own page's scripts; same-origin script execution is equivalent to local compromise for dev tools.

**v0.1 option:** remove the meta tag from the DOM immediately after the content-bootstrap script reads it (one-time DOM mutation).

### 5.2 Co-installed extension can mint a session (TOFU window)

A co-installed extension with localhost permission can contact the daemon before the reDesigner extension and claim the TOFU slot.

**Accepted because:** the attack requires a hostile extension already installed, which is a different threat vector (extension store supply chain or sideloaded extension). The TOFU window is bounded to first daemon boot.

**v0.1 fix:** explicit Web-Store extension ID binding in the daemon's allowlist, configured at extension install time.

### 5.3 DevTools WebSocket header visibility

The WebSocket upgrade handshake, including `Sec-WebSocket-Protocol: redesigner-v1, base64url.bearer.authorization.redesigner.dev.<token>`, is visible in Chrome DevTools → Network → WS → Headers.

**Accepted because:** DevTools access implies the attacker already has the developer's local browser session and machine. No meaningful escalation beyond that access.

**No fix planned** — this is an inherent property of browser DevTools.

### 5.4 `chrome://net-export` captures session token

`chrome://net-export` logs capture full HTTP/WS headers including the subprotocol. A developer sharing a net-export log for debugging inadvertently shares their session token.

**Accepted because:** net-export is a deliberate developer action; the session token is short-lived (bounded to daemon uptime). Log sharing guidelines should remind developers to redact `Sec-WebSocket-Protocol` lines.

**Documentation fix:** add a note to developer docs to redact net-export logs before sharing.

### 5.5 Reverse-proxy log exposure

If a corporate or personal proxy logs WebSocket upgrade headers (e.g., Charles Proxy, mitmproxy, Fiddler), the session token appears in the proxy's session log.

**Accepted because:** a proxy in the local TLS chain is a developer-elected trust boundary alteration. No fix in v0.

**v0.1 option:** secondary challenge-response (OPAQUE or SRP) to avoid transmitting the token in any header. Expensive; deferred.

### 5.6 Third-party inline scripts at app origin

Analytics, CDN widgets, or other third-party scripts embedded at the app's origin can read the bootstrap meta tag.

**Accepted because:** the developer is responsible for the scripts they run on their dev server. For production apps where the Vite plugin is conditional, this tag should be stripped in production builds — `transformIndexHtml` already gates on `NODE_ENV !== 'production'`.

---

## 6. Non-Threats (Explicitly Out of Scope)

- **Cross-site attacks from a different origin:** The `Sec-Fetch-Site` + host allowlist compound predicate blocks these.
- **Web Store extension review:** reDesigner dev extension is sideloaded; store-signed packages are a v1 concern.
- **Physical machine access:** Out of scope for all software security models.
- **Extension auto-update supply chain:** Mitigated by the tilde-pin policy on `@crxjs/vite-plugin` and `pnpm` lockfile integrity checks.

---

## 7. Review Cadence

This document should be reviewed when:

- A new RPC endpoint or auth path is added to the daemon.
- `externally_connectable` host patterns change.
- The extension gains new `permissions` that expand its attack surface.
- A v0.1 fix from section 5 is shipped (remove or downgrade the corresponding residual).

Last reviewed: **2026-04-20** (v0 initial threat model).
