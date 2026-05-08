# Architecture

## One-paragraph summary

SoA-Web is the server half of the SoA-Prod desktop app, pulled out and made into a standalone Node process. Browsers connect to `/`, get a static SPA, and open a WebSocket to `/ws`. The server owns one PTY per tab per session, tracks sessions by signed HttpOnly cookie, and ignores everything Electron-specific that used to live in the desktop (native menus, auto-updater, Picovoice, local Whisper, macOS SFSpeech, file-icon generation, DMG build, notarization, LAN mobile-pairing).

```
  Browser (xterm.js)                    Node server
  ───────────────────                   ──────────────────────────────
  │                  │       WS        │                            │
  │  Shell UI        │  ◄───── /ws ────►  SessionStore  ──►  TabManager  ──►  node-pty  ──►  $SHELL
  │  Tabs, input     │                 │       ▲                    │
  │  TRON palette    │       HTTP      │       │                    │
  │                  │  ◄──── / ───────►  Express (static + api)    │
  ────────────────────                   ──────────────────────────────
```

## Request → PTY timeline

1. **HTTP boot.** Browser loads `/` (static SPA). First byte fetches `/_config.js` (injects the auth mode) and `/_protocol.js` (rewrites the server's CommonJS `protocol.js` into an ESM shim so the client imports the *same* schema the server uses).
2. **Auth.** If `SOA_WEB_AUTH=shared`, the SPA shows a password form; on success it POSTs `/api/login`, the server returns a signed cookie (`soa_web_auth`). In `open`/`none`, the server auto-provisions a session on any authed request.
3. **WebSocket upgrade.** `/ws` reads the cookie, verifies the HMAC, looks up the session in `SessionStore`. No session = 401.
4. **HELLO.** Server sends `{t:'hello', d:{tabs:[…]}}` describing any tabs that already exist (for a page refresh).
5. **Tab creation.** Client sends `{t:'input', d:{kind:'new-tab', cols, rows}}`. Server spawns a PTY via `TabManager.open`, streams `{t:'term-data', d:{id, data}}` frames back as the shell produces output.
6. **Typing.** Key events → `{kind:'term-keys', id, text}` frames → `tab.write(text)`.
7. **Resize.** xterm fit-addon computes new cols/rows on every window resize and when switching tabs. Server calls `pty.resize`.
8. **Close.** Browser close → WS close → session detaches socket but **keeps** its PTYs. Session GC sweeps idle sessions after `SOA_WEB_SESSION_TTL_MS` (default 6h).

## Why a signed cookie, not a JWT

Sessions are server-side. The cookie carries only a random 256-bit token; the server maps token → in-memory session. HMAC over the cookie prevents forgery; rotating the sign key invalidates all sessions on next request. No JWT means no revocation pain and no accidental "forever" tokens.

## Threat surface (deliberately narrow)

This is a **single-user self-hosted** design. What that buys:

- No user account model, no password reset flow, no billing, no tenant isolation.
- Every session runs as the same OS user the server was launched as. If you run `npm start` as yourself, every browser in shared-secret mode ends up with *your* shell.
- Filesystem isolation, CPU/memory limits, and resource sandboxing are delegated to the deploy (Docker, systemd-nspawn, Fly Machines, etc.), not the app.

If you want **multi-tenant** — say, a hosted service where strangers sign up — the pieces that need to change are:

- Swap `shared` auth for an OIDC/OAuth flow (Auth0, Clerk, Cloudflare Access).
- Make `TabManager.open` spawn the PTY inside a per-user container (e.g. `docker exec`, Firecracker, gVisor). The rest of the protocol doesn't change.
- Add per-session rate limits on `term-keys` (trivial DoS vector otherwise).
- Persist tab state to disk so a process restart doesn't drop shells.

## Protocol

Frames are JSON over WebSocket:

```
{ "v": 1, "t": "<type>", "d": { … }, "id"?: "<correlation>" }
```

See `server/src/protocol.js` for the authoritative list of `t` values and `input.kind` values. Server → client types: `hello`, `snapshot`, `term-data`, `term-exit`, `notice`, `pong`, `bye`. Client → server: `auth`, `input`, `ping`, `request`.

The one clever bit: the *same file* is shipped to the browser. `server/src/index.js` serves `/_protocol.js` by reading `protocol.js` and rewriting the trailing `module.exports = {...}` into `export { ... }`. The two sides cannot drift.

## What tests cover

- `auth`: cookie signing, tamper rejection, mode resolution, constant-time comparison.
- `protocol`: round-trip framing, rejection of malformed/wrong-version frames.
- `sessions`: create/destroy, token lookup, idle GC.

End-to-end (`scripts/smoke-ws.js`) covers the full HTTP → WS → PTY round-trip.

## Open issues / next steps

- **TLS.** Terminate in front with nginx/Caddy/Cloudflare. The app intentionally speaks plain HTTP; there's no good reason to handle certs in-process.
- **CSRF on `/api/login`.** Current cookie is `SameSite=Lax`, which handles the common cases. A public deploy should add an explicit CSRF token.
- **WS origin check.** Currently accepts any origin with a valid cookie — fine for self-hosted, tighten for public deploys via an `Origin` allowlist in the upgrade handler.
- **Voice.** Pluggable transcription endpoint (browser sends audio → server returns text) would restore the desktop's dictation flow without a local Whisper.
