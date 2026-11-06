# Code panel

View, edit and save files from the dashboard and the phone companion, in the
folder of the active terminal tab.

## Where it is

- **Desktop dashboard:** the right panel's **Context | Code** switch. Mod-Shift-E
  (⌘⇧E on a Mac, Ctrl+Shift+E elsewhere) opens it from anywhere, the terminal
  included, and opens a tucked-away panel. The code view can widen the panel to
  60% of the window (Widen, or drag the panel edge); a hand-set width replaces
  Widen, and double-click on the edge resets it.
- **Phone companion (`/m/`):** the **CODE** button in the bottom bar (also
  `?view=code`). The explorer is a drawer; the editor shrinks above the soft
  keyboard. Hidden, not destroyed, when you switch away, so unsaved buffers
  survive.

Both load `web/public/assets/codePanel.js` on first use, and it loads the
vendored CodeMirror 6 bundle (`assets/vendor/codemirror-6/cm.js`; how to
rebuild it is in that folder's `BUILD.md`). Nothing loads until Code is opened.

## The file service

`scripts/soa-code` is a loopback-only HTTP service on `127.0.0.1:6083`
(`SOA_CODE_PORT`). The page reaches it only through the daemon's authenticated
`/preview/6083/` proxy, so the pairing token and password that guard the
terminals guard this too, and it works over the same tunnel with no daemon
restart.

| Route | Purpose |
| --- | --- |
| `GET /api/health` | version and allowed roots |
| `GET /api/tree?path=&hidden=` | one directory level |
| `GET /api/file?path=` | UTF-8 text and sha1 (at most 2 MB, not binary) |
| `POST /api/file` (also `PUT`) | `{path, content, baseSha, create?}`, atomic write |
| `GET /api/stat?path=` | polled every 4 s to catch changes made elsewhere |
| `GET /api/find?root=&q=` | quick-open file-name search |
| `GET /api/grep?root=&q=` | literal text search (ripgrep when installed) |
| `GET /api/git?root=` | read-only git status letters |

### Path policy

- Every path is resolved with `realpath` and must stay inside an allowed root:
  `SOA_CODE_ROOTS` (colon-separated), default the home directory. A symlink
  cannot walk out.
- Never read: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/Library/Keychains` and the SoA
  state dir. Search honours the same list.
- Never written: all of the above, anything under `~/Library`, and anything
  inside a `.git` directory. A read-only file is never replaced.

### Request defences

On top of the proxy's pairing gate:

- **Host** must be `127.0.0.1:<port>` or `localhost:<port>`, so a DNS-rebound
  page still fails.
- Every `/api/*` request must carry **`x-soa-code: 1`**. A custom header forces a
  CORS preflight, which the service never answers with `Access-Control-*`
  headers, so another origin cannot send a write at all.
- An **Origin**, when present, must be one the dashboard is really served from:
  loopback or an IP literal, this Mac's own host name, `s0a.app`, the native
  shells (`capacitor://localhost`, `ionic://localhost`), the current tunnel host
  (read from the state dir), or an entry in `SOA_CODE_ORIGINS` /
  `SOA_WEB_ALLOWED_ORIGINS`.

### Saving

Each save carries the sha the buffer was loaded from. If the file changed on
disk since, the write is refused and the panel shows a conflict banner
(Overwrite, Reload from disk, Compare); nothing is overwritten unless you
choose Overwrite. Writes go to a temporary file and are renamed into place.

Saves are sent as **POST with a `text/plain` body** on purpose:

- the daemon's CORS preflight allows only GET and POST, so a dashboard served
  from another origin (for example `s0a.app` over a tunnel) cannot use PUT;
- the daemon's global JSON body parser would consume an `application/json`
  body, capped at 16 KB, before the `/preview/` proxy forwarded it.

The companion's service worker never caches `/preview/`, so an open file is
never served from a stale cache.

## Running it

```bash
cp deploy/launchd/com.soa-web.code.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.soa-web.code.plist
```

The plist runs `scripts/soa-code` with KeepAlive. Log:
`~/.soa-web-local/logs/code.log`. When the service is not running the panel
says so and shows the command above.

Environment: `SOA_CODE_PORT` (6083), `SOA_CODE_ROOTS`, `SOA_CODE_ORIGINS`,
`SOA_CODE_RG` (path to ripgrep), `SOA_CODE_REQUEST_TIMEOUT_MS`.

## Tests

`server/test/soaCode.test.js` starts the service on a free port against a
temporary root and covers the path policy, the header, Host and Origin checks,
concurrent-save refusal, find, grep and git. Tests that need `git` or `rg` are
skipped when those are not installed.
