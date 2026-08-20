# SoA-Web

**Son of Anton, reimagined as a web app.**

A browser-native terminal UI that streams real PTY sessions over WebSocket. No Electron, no installer, no auto-updater — one Node process serving static assets and a `/ws` channel that owns the shells on your behalf.

Derived from [SoA-Prod](https://github.com/SimonSaysGiveMeSmile) (the desktop Son of Anton). The desktop app already speaks this protocol between its Electron main process and the phone client, so the web port is mostly a matter of making the server side the primary entrypoint instead of a side-feature.

## What moved, what changed

| Desktop feature              | Web equivalent                                     |
| ---------------------------- | -------------------------------------------------- |
| `node-pty` in Electron main  | `node-pty` in Node server                           |
| Renderer via `require()`     | Browser ESM — all Electron calls removed           |
| IPC                          | WebSocket framed JSON (`protocol.js`)              |
| `shell.openExternal`         | Standard anchor / `window.open`                    |
| Caps-Lock wake word / SFSpeech / local Whisper | Gone — Web Speech API is the planned path |
| Auto-updater, DMG, notarize  | Gone                                                |
| Mobile pairing, QR, LAN-bridge | Cloudflare Quick Tunnel — auto-started on boot; sidebar shows the QR |

## Feasibility note

Can this replace the desktop app on the web? **Yes, functionally.** The scary parts all have solutions:

- **Multi-tenant isolation.** Each browser session owns PTYs on the server. For a *single-user* self-hosted deploy (the default this repo targets), that's fine. For a shared deploy, drop each session into a container/VM per user.
- **Auth.** `SOA_WEB_AUTH=shared` with `SOA_WEB_PASSWORD` gates access behind a signed HttpOnly cookie. `none` delegates to an upstream proxy (Cloudflare Access, tailscale funnel, oauth2_proxy). `open` is localhost-only.
- **Claude Code, etc.** Any CLI you want to use runs server-side inside the PTY. Install it on the host; your browser is just the glass.

## Running it

```bash
npm install
SOA_WEB_PASSWORD=correct-horse-battery npm start
```

Open http://127.0.0.1:7332. The default shell is `$SHELL` (override with `SOA_WEB_SHELL`).

### Config

| Var                       | Default              | Meaning                                                     |
| ------------------------- | -------------------- | ----------------------------------------------------------- |
| `SOA_WEB_HOST`            | `127.0.0.1`          | Bind address. Use `0.0.0.0` for LAN/cloud.                   |
| `SOA_WEB_PORT`            | `7332`               | Listen port.                                                 |
| `SOA_WEB_AUTH`            | `open` / `shared`    | `open` \| `shared` \| `none`. See `server/src/auth.js`.    |
| `SOA_WEB_PASSWORD`        | —                    | Required when `SOA_WEB_AUTH=shared`.                         |
| `SOA_WEB_SIGN_KEY`        | random, per-process  | HMAC key for cookies. Set this in prod to survive restarts. |
| `SOA_WEB_SHELL`           | `$SHELL`             | Shell binary to spawn.                                       |
| `SOA_WEB_SESSION_TTL_MS`  | `6h`                 | Idle session expiry.                                         |
| `SOA_WEB_SECURE_COOKIE`   | `0`                  | Set `1` behind HTTPS so cookies are `Secure`.                |
| `SOA_WEB_DEV`             | unset                | Dev mode — disables static caching.                         |
| `SOA_WEB_AUTOPAIR`        | `1`                  | Auto-start the Cloudflare tunnel on boot. Set `0` to skip. |
| `SOA_WEB_SCROLLBACK_BYTES`| `262144`             | Per-tab replay buffer. Restores scrollback on reconnect.   |

The server **refuses to start** with `SOA_WEB_AUTH=open` on any non-loopback host. That's by design — a web terminal with no auth on a public IP is a root shell for everyone on the internet.

## Layout

```
soa-web/
├── server/
│   ├── src/
│   │   ├── index.js           # HTTP + WS entry
│   │   ├── auth.js            # shared-secret + signed cookies
│   │   ├── sessionStore.js    # per-browser session + PTY pool
│   │   ├── tabManager.js      # node-pty wrapper
│   │   ├── tabPersist.js      # tabs/scrollback survive a restart
│   │   ├── sessionManager.js  # fleet supervisor + the /api/sessions action surface
│   │   ├── meetStore.js       # group-meeting ledger (append-only JSONL, local only)
│   │   ├── meetings.js        # /api/meetings — the human's meeting surface
│   │   ├── tabApi.js          # /api/tabs + /api/browse
│   │   ├── claudeUsage.js     # token-spend engine behind the usage panel
│   │   ├── tunnel.js          # public channel (cloudflared / ngrok) + failover
│   │   └── protocol.js        # wire schema (also served to browser)
│   └── test/                  # node:test suites (see Testing)
├── web/public/                # static browser bundle (xterm.js over CDN)
│   ├── index.html
│   ├── assets/
│   │   ├── app.js             # SPA entry
│   │   ├── bridge.js          # WS client
│   │   ├── widgets.js         # sidebar widgets (fleet, usage, QR)
│   │   └── styles.css         # TRON palette
│   └── m/                     # dependency-free mobile client (PWA, served at /m/)
├── mobile/                    # mobile companion PWA packaging
├── mobile-ios/                # native iOS shell (Capacitor) bundling /m/
├── deploy/launchd/            # supervision plists (daemon, watchdogs, timers)
└── scripts/
    ├── fix-pty-perms.js       # postinstall: chmod +x prebuilt spawn helper
    ├── smoke-ws.js            # end-to-end PTY round-trip check
    ├── soa-sessions           # manager-agent CLI: see/drive every other session
    ├── soa-meet               # agent CLI for group meetings (say/read/rooms/who)
    ├── soa-bus                # local-only agent-to-agent message bus
    ├── soa-work               # local-only work-claim ledger (no double edits)
    ├── soa-msg                # message the user's phone (mobile CHAT)
    └── soa-watchdog           # liveness probe used by the launchd timer
```

## Testing

```bash
npm test                          # node:test suites in server/test/*.test.js
node scripts/smoke-ws.js          # boot server first; verifies PTY round-trip
node scripts/manager-smoke.js     # manager loopback surface, against a THROWAWAY daemon
node server/test/stress/stress.js # isolated mock daemons hammered for persistence/clobber bugs
```

`npm test` covers auth (cookie signing), the protocol framing, session
create/GC, tab titling + scrollback, tab persistence, and the fleet manager —
including group meetings (roster resolution, the poke gate, the relay budget,
the ledger cursor). The stress harness spins up its own throwaway daemons on a
temp state dir and never touches a running fleet.

`manager-smoke.js` does **not** — read this before running it. It spawns no
daemon of its own; it drives whatever daemon answers on `SOA_WEB_PORT` (falling
back to `:7700`). Pointed at a live fleet it really will open and stop tabs and
convene and adjourn a meeting inside it. Boot a throwaway daemon first and give
it its own state dir:

```bash
SOA_WEB_PORT=7700 SOA_WEB_STATE_DIR=~/.soa-web-mgrtest SOA_WEB_HOST=127.0.0.1 \
  SOA_WEB_AUTOPAIR=0 SOA_WEB_NO_AUTO_RESUME=1 SOA_WEB_MANAGER_ENABLED=1 \
  node server/src/index.js &
SOA_WEB_PORT=7700 node scripts/manager-smoke.js
```

## What's deliberately missing

- **Voice input.** The desktop's Picovoice wake-word and local Whisper don't port. Plan for a web build: Web Speech API on click, or a server-side Whisper endpoint.
- **Native menus, tray, global hotkeys, file-icon generator.** All Electron-only — dropped.
- **Auto-updater, notarization, DMGs.** Irrelevant for a web deploy.

## Phone access

On boot the server opens a [Cloudflare Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) and prints the public URL. The sidebar's **MOBILE LINK** widget renders a QR for the same URL — scan it and the phone lands on the web UI. Requires `cloudflared` on `PATH`; falls back to `ngrok` or `localtunnel` if not. Disable with `SOA_WEB_AUTOPAIR=0`.

> **Vercel deploys ship only the SPA.** The Node server (PTYs, WebSockets,
> sessions) can't run on serverless. Point `SOA_WEB_BACKEND` at a tunneled
> self-hosted backend instead — see below.

## Vercel + tunneled backend

Split-deploy setup: Vercel hosts the static SPA on your public domain,
and the Node server keeps running on a box you control. The SPA talks
to the backend over a Cloudflare Tunnel (or any public HTTPS URL).

1. **Start the backend with an allowlist** for the Vercel origin so CORS
   and the WebSocket upgrade accept the cross-site traffic, and so the
   cookie flips to `SameSite=None; Secure`:

   ```bash
   SOA_WEB_PASSWORD=… \
   SOA_WEB_ALLOWED_ORIGINS=https://your-app.vercel.app \
   SOA_WEB_SECURE_COOKIE=1 \
   npm start
   ```

   Autopair prints the public tunnel URL (e.g.
   `https://foo-bar-baz.trycloudflare.com`). Note it.

2. **Configure Vercel project environment variables**
   (Settings → Environment Variables, Production + Preview):

   | Key                | Example value                              |
   | ------------------ | ------------------------------------------ |
   | `SOA_WEB_BACKEND`  | `https://foo-bar-baz.trycloudflare.com`    |
   | `SOA_WEB_AUTH`     | `shared` (match the backend)               |

3. **Redeploy.** `scripts/vercel-build.js` runs automatically and rewrites
   `web/public/_config.js` with the baked-in backend origin. The SPA then
   points `fetch('/api/…')` and the `/ws` upgrade at that host.

Quick-tunnel URLs change on every backend restart — either use a named
Cloudflare Tunnel with a stable subdomain, or redeploy Vercel after each
restart to refresh `SOA_WEB_BACKEND`.

## License

GPL-3.0, matching the desktop project.
