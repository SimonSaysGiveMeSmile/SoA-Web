# SoA Mobile Terminal Client — Porting / Replication Guide

A self-contained, dependency-free browser client that streams a real terminal
(PTY) over a WebSocket and renders it on mobile: multi-tab, cursor-addressed
grid rendering (full-screen TUI apps like agent CLIs work), ANSI colour, an
on-screen keyboard, agent-status tab colours, and an offline PWA shell.

No build step, no framework, no npm install — plain ES modules + CSS. To
replicate it elsewhere you need (1) these static assets and (2) a backend that
speaks the WebSocket protocol below.

---

## 1. Files in this bundle

| File | Purpose |
|------|---------|
| `index.html` | Entry point. Loads `app.js` as a module. |
| `app.js` | Orchestrator: boot, tabs, render loop, diagnostics panel. |
| `socket.js` | `BridgeSocket` — reconnecting WebSocket, endpoint failover, framing. |
| `terminal.js` | `TermBuffer` — cursor-addressed grid emulator → HTML. |
| `ansi.js` | ANSI/SGR → styled spans; exports the SGR helpers `terminal.js` reuses. |
| `agentDetect.js` | Stream heuristics → agent status (working/attention/done/idle). |
| `keyboard.js` | `VirtualKeyboard` — on-screen input + modifier keys. |
| `sounds.js` | Optional UI sound effects (uses `audio/*.wav`). |
| `styles.css` | All styling (TRON-ish dark theme). |
| `sw.js` | Service worker — caches the shell for offline launch. |
| `manifest.webmanifest`, `icon.svg` | PWA install metadata. |
| `version.json` | `{version}` — used for a mobile/desktop mismatch banner (optional). |
| `audio/*.wav` | Sound-effect assets (optional; remove if you drop `sounds.js`). |

**Module graph:** `app.js` → `socket.js`, `terminal.js` (→ `ansi.js`),
`agentDetect.js`, `keyboard.js`, `sounds.js`. No external/CDN dependencies.

---

## 2. How to mount

Serve the folder at a path (the original serves it at `/m/`) from any static
host. Two requirements:

- **Same-origin WebSocket:** by default the client opens `wss://<page-origin>/ws`.
  Serve the client from the same origin as the backend, or pass an explicit
  backend via `?backend=` / `#backend=` (see `app.js` param parsing).
- **Service-worker scope:** `sw.js` must be served from the path it controls.
  The original only registers it at `location.pathname === '/'`; if you serve
  under `/m/`, either move the registration condition in `app.js` or serve the
  client at the origin root. The app works fine without the SW (it's only the
  offline shell) — it is not required for streaming.

Open `…/m/?t=<token>` (or `…/m/` if the backend sets `tokenRequired:false`).

---

## 3. Backend protocol contract

The client needs an HTTP discovery endpoint, a static mount, and a WebSocket.

### 3.1 HTTP

- `GET /api/ping` → **unauthenticated** discovery. Return:
  ```json
  { "ok": true, "name": "soa-web", "protocol": 1, "tokenRequired": false }
  ```
  `tokenRequired:true` makes the client require a `?t=` token.
- Static serve the client files (original: `GET /m/*` → `index.html` fallback).
- `GET /version.json` (optional) → `{ "version": "x.y.z" }`.

### 3.2 WebSocket — `GET /ws?t=<token>`

Upgrade at `/ws`. Authenticate via the `t` query param (or skip if
`tokenRequired:false`). Every message is a **JSON text frame**:

```js
{ "v": 1, "t": "<type>", "d": { ...payload }, "id": "<optional>" }
```

`v` = protocol version (1). `t` = message type. `d` = payload object.

### 3.3 Server → client messages (`t`)

| `t` | `d` payload | Meaning |
|-----|-------------|---------|
| `hello` | `{ serverVersion, serverTime, tabs:[Tab], activeId, replay:[{id,data}], graveyard:[Tab], connectedDevices }` | Sent once on connect. `replay` is each tab's scrollback to paint immediately. |
| `snapshot` | `{ tabs:[Tab], activeId, connectedDevices, graveyard? }` | Tab list / active-tab changed. Broadcast to all sockets. |
| `term-data` | `{ id, data }` | A chunk of raw terminal output for tab `id` (ANSI bytes). |
| `term-exit` | `{ id, code }` | Tab `id`'s shell exited. |
| `notice` | `{ ... }` | Optional toast/notice. |
| `pong` | `{}` | Reply to `ping`. |
| `bye` | `{}` | Server closing. |

**`Tab` object:** `{ id:number, title:string, cols:number, rows:number, exited:boolean }`.
(Agent status is **not** sent — the client derives it from the stream via
`agentDetect.js`. If your backend can compute status, add a field and set
`data-status` directly instead.)

`activeId` should always be a **real tab id**; the client defends against `0`/
undefined, but sending the correct active id avoids a wrong-tab flash.

### 3.4 Client → server messages (`t`)

| `t` | `d` payload |
|-----|-------------|
| `input` | `{ kind, id, ...kindFields }` — see kinds below |
| `request` | `{ what: "snapshot" }` — ask for a fresh snapshot |
| `ping` | `{}` |
| `auth` | `{ token }` (only if you require post-connect auth) |

**`input` kinds** (`d.kind`), all carry `d.id` = target tab:

| `kind` | fields | server should write to PTY |
|--------|--------|----------------------------|
| `term-keys` | `text` | `text` verbatim (this is how typed chars **and Enter `\r`** arrive) |
| `term-resize` | `cols, rows` | `pty.resize(cols, rows)` |
| `hotkey` | `combo` | map → control bytes: `enter`→`\r`, `tab`→`\t`, `backspace`→`\x7f`, `esc`→`\x1b`, `ctrl+c`→`\x03`, arrows→`\x1b[A/B/C/D`, … |
| `switch-tab` | `id` | set active tab, broadcast `snapshot` |
| `new-tab` | — | spawn a PTY/tab, broadcast `snapshot` |
| `close-tab` | `id` | kill tab |
| `move-tab` | `id, before` | reorder |
| `rename-tab` | `id, title` | rename |
| `restore-tab` | `id` | restore from graveyard |
| `shell-command` | `line` | write `line + "\r"` |
| `set-title` | `id, title` | rename |
| `ctx-report` | `id, pct` | (optional) context-usage report |

> **Gotcha:** the on-screen keyboard sends **Enter as `term-keys {text:'\r'}`**
> (the reliable path). If you instead route Enter as `hotkey {combo:'enter'}`,
> your server's hotkey map **must** include `'enter': '\r'` or commands never
> submit.

### 3.5 Minimal backend behaviour

1. On connect: create/attach a session, send `hello` with the tab list +
   per-tab scrollback in `replay`.
2. Spawn one PTY per tab. On PTY output → broadcast `term-data {id,data}` to
   **all** connected sockets (so phone + desktop stay in sync).
3. On `input` → write the bytes to the addressed tab's PTY.
4. On tab changes → broadcast `snapshot`.
5. Keep a bounded scrollback buffer per tab for `replay` on reconnect.

Any PTY library works (e.g. `node-pty`). The client is backend-agnostic — it
only cares about the JSON frame contract above.

---

## 4. Notes

- **Rendering:** `TermBuffer` is a compact grid emulator (cursor moves, erase
  line/display, SGR colour, OSC-8 links) — enough for shells and agent CLIs.
  It is **not** a full VT100 (no scroll regions, origin mode, separate
  alternate-screen surface). Swap in xterm.js if you need full fidelity.
- **Agent status colours** are heuristic (pattern-matching the stream) and may
  drift from any given CLI's exact output. Tune `agentDetect.js` patterns.
- **Diagnostics:** tap the `LOG` chip (top bar) for an on-screen panel —
  build marker, socket state, message counts, per-tab line counts, event log.
- **No secrets** are embedded. Auth is whatever token your backend issues.
