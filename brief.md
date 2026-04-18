# Project Brief — Browser Element → Claude Code Bridge

*(Name TBD)*

## What this is

A developer tool that turns browser element selection into rich, grounded context for Claude Code. The user picks a DOM element in their running dev build; Claude Code receives a **component handle** (file path, line range, component name, parent chain) instead of a screenshot or CSS selector. Claude Code does everything else — answer questions, read/edit files, run commands — through its own built-in tools.

Framing: "DevTools inspector + Claude Code." The scope of a conversation is a **single DOM node**.

## Core premise (why this is different from Stagewise et al.)

Existing tools target arbitrary sites, so they treat selection as evidence to infer from — screenshots, DOM snapshots, CSS selectors. This tool only works on **dev builds of the user's own project**, which means selection is a **lookup key** into a known codebase, not a guess. Source locations are injected at compile time via a Vite plugin. No screenshots, no source-mapping heuristics at runtime.

## Architecture

Four components with strict separation of concerns. No component should leak responsibility into another.

### 1. Vite plugin (`@tool/vite`)

- At compile time, tags every JSX element with `data-src-loc="file:line:col"`.
- Piggyback on `@babel/plugin-transform-react-jsx-source` (React already emits `__source` in dev) where possible — don't reinvent.
- Emits a project manifest to `.tool/manifest.json`: component names → file paths, export map, framework info.
- Uses Vite's `configureServer` hook to auto-start the daemon alongside `vite dev`. No extra command for the user to run.

### 2. Daemon (Node + TypeScript, long-running)

- Started by the Vite plugin. Lives as long as the dev server.
- **Single source of truth** for: current selection, selection history, project manifest.
- Exposes:
  - a local WebSocket API for the Chrome extension (push selection updates)
  - a local HTTP/Unix-socket API for the MCP shim to query
- One daemon per project. No global daemon multiplexing across projects.

### 3. MCP server shim (`@tool/mcp`, stdio)

- Spawned by Claude Code per session (standard MCP pattern).
- Stateless — proxies to the daemon over localhost.
- Built with `@modelcontextprotocol/sdk`.

**Tools (v0):**
- `get_current_selection()` → `ComponentHandle | null`
- `list_recent_selections(n: number)` → `ComponentHandle[]`
- `get_computed_styles(selectionId: string)` → `Record<string, string>`
- `get_dom_subtree(selectionId: string, depth: number)` → serialized subtree

**Resources:**
- `project://manifest` → full component map
- `project://config` → framework, entry points, project paths

### 4. Chrome extension

- Side panel + element picker.
- Picker: hover-highlight overlay, click to pin selection, shift-click to add.
- On selection, POSTs a selection event to the daemon's WebSocket.
- **No chat UI in v0.** User talks to Claude Code in their terminal; the extension's only job is to keep the daemon's "current selection" up to date. This is deliberate and composes naturally with any future MCP client.

## Component handle shape

```ts
interface ComponentHandle {
  id: string;                // stable UUID — persists after DOM rerenders
  componentName: string;     // e.g., "PricingCard"
  filePath: string;          // project-relative
  lineRange: [number, number];
  domPath: string;           // CSS selector, for fallback/debugging
  parentChain: string[];     // e.g., ["App", "PricingSection", "PricingCard"]
  timestamp: number;
  // runtimeProps: deferred to v1 (requires fiber traversal)
}
```

## Install flow (target UX)

1. User installs the Chrome extension from the Web Store.
2. User adds the Vite plugin: `npm i -D @tool/vite` + two lines in `vite.config.ts`.
3. User runs `npx @tool/cli init` — writes `.mcp.json` at project root (project-scope), safe to commit.
4. User runs `vite dev` — plugin auto-starts daemon alongside dev server.
5. User opens the app in Chrome. Extension badge shows "connected."
6. User opens a terminal, runs `claude`, accepts the workspace trust prompt. MCP shim connects to daemon.
7. User clicks an element via the extension picker.
8. User asks Claude Code: *"Why does this button look different from the others?"* CC calls `get_current_selection()`, reads the file, answers.

## Decisions already made — don't re-litigate

- **React + TypeScript + Vite** for v0. Vue/Svelte/Next.js are adapter work, layered later.
- **Claude Code is the agent** via MCP. Not building a chat loop. Not calling Anthropic's API directly. Not handling auth.
- **MCP transport: stdio**, not HTTP. Standard for local tools.
- **MCP scope: project** (`.mcp.json` at project root, committable), not user-scope.
- **Daemon + shim split.** Shim per CC session (stateless). Daemon long-running (owns state).
- **DOM node as conversation scope.** Not "component" (ambiguous when rendered multiple times) and not "page."
- **Selection is state, not a tool parameter.** User picks in browser → daemon updates → CC reads "what's selected" as a tool when needed.
- **Dev builds only.** If the instrumentation plugin hasn't run, the extension should visibly disconnect rather than silently fall back to guessing.
- **Develop against a dedicated playground app, not an existing project and not an HTML→React→Astro→Next ladder.** See *Development setup* below.

## Development setup

Build in a monorepo with two side-by-side packages:

1. **`your-tool/`** — the actual tool (Vite plugin, daemon, MCP shim, CLI, Chrome extension) as a pnpm workspace or Turborepo.
2. **`examples/playground/`** — a deliberately boring React + TypeScript + Vite app whose only purpose is exercising the tool. Structurally realistic (a `PricingCard` rendered 4× with different props, a `Button` used everywhere, a `Modal` with many props, some nested components, a mix of CSS Modules and Tailwind) but without any real business logic.

### Why not attach to an existing project for v0

Debugging two moving targets at once — *"is my tool broken?"* vs *"is this weird because of something in the host project?"* — is painful for a tool whose entire job is to understand codebases. You want full control over the codebase under the microscope: the ability to intentionally break things (weird JSX, edge-case props, malformed component trees) and see how the tool handles them. Hard to do on a project with real work in flight.

Attaching to a real project is the **validation step**, not the development step. It happens after v0 is solid on the playground — that's when you learn whether your tool survives contact with a codebase you didn't design around it.

### Why not HTML → plain React → Astro → Next

This looks like a "start simple, grow" ladder but it's actually "do four different pieces of work and throw three away":

- **Plain HTML and script-tag React** have no build step, which means no Vite plugin, which means no source-location injection — i.e. no product. Any stub you build there doesn't resemble the real architecture.
- **Astro and Next are not higher rungs of the same ladder** — they're different compilers and different dev-server integrations. Supporting them is per-framework adapter work, explicitly deferred to post-v0. Adding them before React+Vite is even solid just spreads the same bug-hunting across three stacks.

Stay on React + TypeScript + Vite for all of v0. Pick the next framework adapter based on what real users (or you) actually want, not a predetermined sequence.

### Dogfood sequence

Each step proves its upstream dependency works before the next piece gets built:

1. Vite plugin against the playground — verify `data-src-loc` appears on rendered DOM elements.
2. Daemon — manually select elements via Chrome DevTools console, confirm the daemon resolves them correctly.
3. MCP shim — test via `@modelcontextprotocol/inspector` alone. No extension, no Claude Code yet — just prove the tools return the right shape.
4. Claude Code in the terminal — query the daemon while manually updating selection by hand. No extension yet.
5. Chrome extension last. By this point you know exactly what selection data needs to flow, because you've been simulating the extension manually for the previous three steps.

The extension being the last thing built is a useful reminder that it's genuinely the thinnest part of the system.

## Build order

1. **Vite plugin.** Inject source locations, emit manifest. Unit-testable standalone.
2. **Daemon.** WebSocket server, manifest loader, selection state machine. Unit-testable standalone.
3. **MCP shim.** stdio server using the TS SDK, proxies to daemon. Testable with `@modelcontextprotocol/inspector`.
4. **Chrome extension.** Picker UI + WebSocket client. No chat.
5. **CLI (`init`).** Writes `.mcp.json` + scaffolds Vite config snippet.
6. **Dogfood on the playground** until the core loop feels right. Only then point it at a real React+Vite project as the validation step.

## Explicitly out of scope for v0

Add later, in roughly this order:

- Runtime props extraction via React fiber traversal
- Own chat UI in the extension (extension becomes its own MCP client)
- Multi-framework support (Vue → Svelte → Next.js → others)
- DevTools panel variant (alongside side panel)
- Conversation persistence / session history UI
- Web front-end for project management ("load a project")
- OpenAI-compatible fallback backend for users without Claude Code
- Variations / multi-candidate generation flows

## Open questions — not blockers, worth answering early

- **Daemon ↔ extension protocol:** event-based push, RPC, or both?
- **HMR behavior:** when a source file changes, does the manifest update incrementally or does the plugin rebuild it?
- **Port discovery:** fixed port (conflict risk), OS-assigned + handoff file (most robust), or announcement mechanism?
- **Name.** Still TBD.
