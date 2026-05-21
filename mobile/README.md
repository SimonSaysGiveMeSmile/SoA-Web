# Son of Anton — Mobile Companion

A no-build PWA served by the Son of Anton desktop bridge. Pairs via QR code scanned from the desktop app's **MOBILE LINK** widget.

## What it does

- Mirrors the active desktop terminal session (live ANSI output) on the phone
- Lets you switch tabs, type commands, and send hotkeys (Ctrl+C, arrows, etc.) back to the desktop
- Shows a SYSTEM view with CPU / RAM / network / clock cards
- Auto-reconnects aggressively — exponential backoff + visibility/online events + heartbeat

## Files (`dist/`)

| File | Purpose |
|---|---|
| `index.html` | Shell HTML, PWA meta tags, loads `app.js` as ES module |
| `app.js` | Main app: connects socket, renders tabs + terminal + widget cards, wires UI |
| `socket.js` | `BridgeSocket` — robust WS client with reconnect, heartbeat, state events |
| `ansi.js` | Minimal ANSI → HTML renderer (SGR colours + style, strips cursor sequences) |
| `keyboard.js` | `VirtualKeyboard` — on-screen keyboard with hotkeys row for mobile |
| `styles.css` | Sci-fi terminal aesthetic, dark theme |
| `sw.js` | Service worker — offline shell cache |
| `manifest.webmanifest` | PWA manifest (install to home screen) |

## Protocol

Wire format over WebSocket (`/ws?t=<token>`):

```json
{ "v": 1, "t": "<type>", "d": { ... } }
```

**Server → client:** `hello`, `snapshot`, `patch`, `term-data`, `notice`, `pong`, `bye`  
**Client → server:** `input` (with `kind`), `ping`, `request`

Input kinds: `term-keys`, `term-resize`, `switch-tab`, `new-tab`, `close-tab`, `move-tab`, `hotkey`, `voice-toggle`, `shell-command`

## Development

The supported way to reach this app is to launch the desktop and scan its QR code. The desktop bundles this PWA inside its DMG; users never install it separately.

For contributors iterating on the mobile UI without packaging a full desktop build, there's a standalone dev server. It is a contributor tool only — not a supported entry point for users:

```bash
# From the repo root:
npm run dev:mobile                        # serves dist/ on :5173

# To test against a live desktop bridge, proxy /ws and /api:
SOA_BRIDGE=ws://192.168.1.42:7330 npm run dev:mobile
```

Production pairing: the desktop bridge serves `dist/` from `Son of Anton.app/Contents/Resources/mobile/` (packaged) or `<repo>/mobile/dist` (dev). See `../desktop/docs/MOBILE_BRIDGE.md`.

The app reads its token from `?t=<token>` on first load, then persists it in `localStorage` (keyed by origin) so PWA reopens reconnect without a re-scan.

## Connection flow

1. User taps **PAIR** on the desktop **MOBILE LINK** tile  
2. Main process starts HTTP+WS (port **7330+**) and rotates a session token (`SessionStore`)  
3. The widget requests a **`mobile:qr`** PNG in the **main** process (**`qrcode`**), encoding **`http(s)://…/?t=`** (**LAN**, or **`localtunnel`** when ready)  
4. Phone scans → loads `index.html` → JS opens **`ws://…/ws?t=`** when the page was served over **http**, or **`wss://`** when served over **https** (e.g. some tunnel hosts)  
5. Server sends **`hello`** + **`snapshot`** replay  
6. Desktop renderer snapshots ~**250 ms** while **`running && paired clients > 0`**, and streams **`term-data`** over IPC between snapshots  
7. Phone **`input`** events are dispatched on the desktop (terminal socket, tabs, **`toggleMic()`,** etc.)

## Operational notes

- **Desktop pairing** depends on **`qrcode`** in `son-of-anton-public/src/node_modules`; QR PNGs are generated in the **main process** (`mobile:qr` IPC), not inside the Chromium renderer (avoids brittle `require` + CSP issues there).
- **`localtunnel`** is best-effort on the desktop: LAN QR always appears when the bridge starts; **`PUB`** may show “tunnel unavailable”.
- Mobile app mirrors terminal + SYSTEM cards + tab actions only — no desktop voice UI or full widget parity yet.
