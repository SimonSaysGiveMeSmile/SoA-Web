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
│   │   ├── index.js         # HTTP + WS entry
│   │   ├── auth.js          # shared-secret + signed cookies
│   │   ├── sessionStore.js  # per-browser session + PTY pool
│   │   ├── tabManager.js    # node-pty wrapper
│   │   └── protocol.js      # wire schema (also served to browser)
│   └── test/
│       └── unit.test.js
├── web/public/              # static browser bundle (xterm.js over CDN)
│   ├── index.html
│   └── assets/
│       ├── app.js           # SPA entry
│       ├── bridge.js        # WS client
│       └── styles.css       # TRON palette
└── scripts/
    ├── fix-pty-perms.js     # postinstall: chmod +x prebuilt spawn helper
    └── smoke-ws.js          # end-to-end PTY round-trip check
```

## Testing

```bash
npm test           # unit tests (auth, protocol, sessions)
node scripts/smoke-ws.js   # boot server first; verifies PTY round-trip
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
