# soa-artifacts — the artifact library

`scripts/soa-artifacts` keeps one searchable list of every claude.ai artifact an
agent on this Mac published, opened, registered or mentioned. The dashboard's
CONTEXT panel (ARTIFACTS band and **All artifacts**) and the phone companion
(⋯ → Artifacts) read it.

It is a standalone loopback service (`127.0.0.1:6085`), reached by browsers
through the daemon's authed `/preview/6085/` proxy, so it needs **no daemon
restart**, no sudo and no new permission. It only reads files the agents
already write; the only thing it writes is its own index.

## Running it

```bash
nohup node scripts/soa-artifacts serve >> ~/.soa-web-local/logs/artifacts.log 2>&1 &   # by hand
cp deploy/launchd/com.soa-web.artifacts.plist ~/Library/LaunchAgents/ &&
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.soa-web.artifacts.plist
```

When it is not running, the CONTEXT panel falls back to the artifacts in the
current session's transcript (`contextCanvas.js`), and the CLI scans in-process.

The launch agent uses standard resource limits so startup and interactive
search requests stay responsive. Scanning remains incremental; the phone
stops refreshing when its library sheet closes or the page is hidden.

State: `${SOA_WEB_STATE_DIR:-~/.soa-web-local}/artifacts/index.json` (0600, in a
0700 directory). Log: `~/.soa-web-local/logs/artifacts.log`.

## Sources

| Source | What it gives |
|---|---|
| `~/.claude/projects/<enc-cwd>/<sid>.jsonl` | Claude Code transcripts |
| `~/.claude/projects/<enc-cwd>/<sid>/**/*.jsonl` | subagent transcripts, credited to the parent session `<sid>` |
| `<state>/context/<sid>.json` | artifacts registered with `soa-ctx artifact <url> [title]` |
| `~/.codex/sessions/**/*.jsonl` | Codex rollouts (URL mentions only; the first record names the thread and its cwd) |

## What counts

Each artifact gets one `kind`, strongest first:

- **published** — a `frame-link` record, or an `Artifact` publish whose result
  says `Published … at <url>` (or carries the structured result's `url`).
- **registered** — a `soa-ctx` registration.
- **opened** — any other `Artifact`, `ArtifactData` or `ArtifactComments` call on
  a URL (open, read, comments, database and asset calls).
- **mentioned** — a bare URL in a message or a tool's output.

A successful `Artifact` delete of a whole artifact (not a database or asset
delete) marks it `deleted: true` until it is published again. A delete whose
result is an error, a refusal or a declined confirmation does not count.

Title, first match wins: the `frame-link` title, the publish call's `title` (or
the structured result's), the `soa-ctx` registration's title, then the
`<title>` of the published HTML file if it is still on disk.

Where an artifact lives (`project`, `cwd`, `firstAt`/`lastAt`) comes only from
the sessions that worked on it. A URL pasted into another session, or printed by
a grep over the transcripts, is listed under `sessions` but never moves it or
makes it look recently used; a URL seen only in tool output keeps the session it
first appeared in.

Only real URL shapes count: `https://claude.ai/code/artifact/<uuid>`,
`https://claude.ai/public/artifacts/<uuid>` and `https://claude.ai/artifact/<uuid
or 21–22 character base58 id>`, with the id ending where the URL does.
Placeholders (`{id}`, `<uuid>`, `12345678-aaaa-…`), lookalike hosts and ids cut
short by a truncated tool output are ignored. The canvas (`contextCanvas.js`)
uses the same shapes.

## Scanning

Incremental: each file's byte offset, size, mtime and inode are kept in the
index, so a rescan (every 20 s, `SOA_ARTIFACTS_RESCAN_S`) reads only what was
appended. Only complete lines are consumed — a half-written last line is read
again next time. A file that got shorter or was replaced (a new inode) is read
again from the start; re-reading never double-counts, because applying an event
twice changes nothing. A transcript that disappears keeps its artifacts.

Lines are split as raw bytes and only a line holding `claude.ai/`, `frame-link`,
an `Artifact` tool call, or the result of a pending publish/delete call is
decoded. Request-blob and prompt-snapshot records are skipped. A line over 8 MB
is not parsed as JSON (its URLs still count as mentions); a line over 64 MB is
dropped. The first scan of several GB takes tens of seconds and yields between
files and chunks, so the server keeps answering throughout.

Bumping the index version (a change to what is extracted) makes the next start
rebuild the index from scratch.

## HTTP API (JSON)

| Request | Answer |
|---|---|
| `GET /health` | `{ok, service, version, scanning, total, updatedAt, uptimeSec}` |
| `GET /artifacts?q=&cwd=&session=&limit=&kind=` | `{ok, updatedAt, scanning, total, artifacts:[…]}`, newest first. `q` searches title, description, project, URL and id; `cwd` matches the artifact's home sessions at or under that directory; `kind` is a comma list; `limit` defaults to 500 |
| `GET /artifacts/<id>` | `{ok, artifact}` or 404 |
| `POST /rescan` | `{ok, scanning, scan}` — `started`, `queued` (one more after the running scan) or `deferred` (scans run no closer than 3 s apart). Empty body, or `application/json` / `text/plain`; a body over 4 KB is refused (413) |

An artifact: `{id, url, title, description, kind, deleted, firstAt, lastAt,
project, cwd, sessions:[{sessionId, cwd, project, agent, firstAt, lastAt,
actions}], tabs:[{id, title}]}`. `tabs` are the live dashboard tabs on the same
session or directory. Paths of the published HTML files never leave the service.

### Request guard

The same as soa-health's: the peer must be loopback and the `Host` header a
loopback name with this port (a DNS-rebinding guard). A `Sec-Fetch-Site:
cross-site` request (or a same-site non-GET) is accepted only when its `Origin`
is one of the public front ends (`https://www.s0a.app`, `https://s0a.app`, plus
`SOA_ARTIFACTS_ALLOWED_ORIGINS`) **and** it carries a forwarding header the
daemon reads as an internet caller (`cf-connecting-ip`, `x-forwarded-for`,
`x-real-ip`, `forwarded`) — that is, it came through the daemon's `/preview`
proxy, which has already required the pairing token (and the password unlock).
Nothing here is a mutation beyond refreshing the service's own index.

## CLI

```bash
soa-artifacts list [--q TEXT] [--cwd DIR|.] [--session ID] [--kind K] [--limit N] [--json]
soa-artifacts open <id|id-prefix|url> [--launch]    # print the URL (exit 3: unknown or ambiguous)
soa-artifacts rescan
```

Without the service running, `list`, `open` and `rescan` load the saved index
and bring it up to date in-process.

## Environment

`SOA_ARTIFACTS_PORT` (6085), `SOA_WEB_STATE_DIR`, `SOA_ARTIFACTS_DIR` (index
directory), `SOA_ARTIFACTS_RESCAN_S` (20, 2–3600), `SOA_ARTIFACTS_CLAUDE_DIR`
(`~/.claude/projects`), `SOA_ARTIFACTS_CODEX_DIR` (`~/.codex/sessions`),
`SOA_ARTIFACTS_DAEMON` (`http://127.0.0.1:4010`, for the live tab list),
`SOA_ARTIFACTS_LOG`, `SOA_ARTIFACTS_ALLOWED_ORIGINS`.

Tests: `server/test/artifactsLibrary.test.js`.
