# soa-mcp: a private MCP library on each device

`scripts/soa-mcp` is a small MCP server that every agent on this machine can
share: Claude Code, Codex, Claude Desktop, or anything else that speaks MCP.
Ask any agent to **save a skill or a piece of code**, and any later session can
read it back. Everything stays in this install's state dir. Nothing is
uploaded, and nothing listens on a public interface.

It is a standalone script with no npm dependencies. It does not need the daemon
to be restarted, and the daemon does not need to be running except for the
read-only `fleet_*` tools.

## Register it

stdio is the recommended mode. Each client starts its own copy, and every copy
reads and writes the same store.

```bash
# Claude Code (all projects)
claude mcp add soa -s user -- ~/.soa-web/scripts/soa-mcp

# Codex: ~/.codex/config.toml
[mcp_servers.soa]
command = "/absolute/path/to/.soa-web/scripts/soa-mcp"

# Claude Desktop: claude_desktop_config.json
"mcpServers": { "soa": { "command": "/absolute/path/to/.soa-web/scripts/soa-mcp" } }
```

`soa-mcp doctor` prints the exact paths for this install, and whether `soa`
is registered in Claude Code (`~/.claude.json`, user scope) and in Codex
(`config.toml`). Sessions that are already running pick the server up the next
time they start or resume.

When a client connects, the server's `initialize` reply carries short
instructions. They tell the agent to check the library (`search`,
`list_skills`, `get_skill`) before writing a procedure from scratch, and to
save reusable procedures with `save_skill` when the user asks. They also say
that the content stays on this device.

## Native skills in every session

An MCP prompt is a slash command (`/mcp__soa__<name>`). Claude Code does not
trigger it on its own the way it triggers a native skill, and Codex may not
show MCP prompts at all. So soa-mcp also **mirrors every library skill as a
native skill** in both clients:

```
~/.claude/skills/<slug>/SKILL.md                 Claude Code
${CODEX_HOME:-~/.codex}/skills/<slug>/SKILL.md   Codex (same SKILL.md format)
```

The mirror covers user skills and preset skills. When a user skill has the same
name as a preset, the user skill wins. Sync runs at server start, after every
successful `save_skill` or `delete_skill`, and on demand:

```bash
soa-mcp sync              # write the mirrors; exit 3 if there were conflicts
soa-mcp sync --dry-run    # report only
soa-mcp sync --json
```

Agents can do the same through the `sync_skills` tool (`dry_run` is optional)
and `export_skill(name)`, which syncs one skill.

Safety rules:

- A directory belongs to soa-mcp only if it contains `.soa-mcp-managed`. That
  file is JSON holding the source (`user` or `preset:<pack>`) and the sha256 of
  the `SKILL.md` that soa-mcp wrote. Sync never writes into, or deletes, a
  directory without that file. An existing skill with the same name is
  reported as a conflict instead. For example, a library skill named `chatgpt`
  leaves your own `~/.claude/skills/chatgpt` alone.
- If you edit a managed `SKILL.md` by hand, its hash no longer matches. Sync
  then leaves that file alone and reports it. To re-sync it, delete the
  directory.
- A name that matches a Codex built-in skill (`skills/.system/<name>`) is not
  written to Codex.
- When you delete a library skill, sync removes its managed mirror. If you added
  other files to that directory, they stay where they are.
- New directories are built under a temp name and then renamed into place, and
  files are replaced atomically. Directories are created 0700 and files 0600.
  A symlinked skills root is refused.
- A default target is used only when the client is installed, meaning
  `~/.claude` or the Codex home exists.

| env | effect |
|---|---|
| `SOA_MCP_SYNC=0` | turns off automatic sync (`soa-mcp sync` still works) |
| `SOA_MCP_SKILL_PREFIX=<p>` | mirror as `<p>-<name>`. Mirrors under the old names are cleaned up |
| `SOA_MCP_CLAUDE_SKILLS_DIR` / `SOA_MCP_CODEX_SKILLS_DIR` | target directories. `off` disables one |
| `CODEX_HOME` | Codex home (default `~/.codex`) |

## What agents can do

| tool | what it does |
|---|---|
| `save_skill(name, description, body, overwrite?)` | store a skill (Claude Code `SKILL.md` format) |
| `list_skills(query?)` · `get_skill(name)` · `delete_skill(name, confirm:true)` | browse, read and remove skills |
| `save_snippet(name, code, language?, title?, description?, tags?, overwrite?)` | store a piece of code |
| `list_snippets(query?, tag?)` · `get_snippet(name)` · `delete_snippet(name, confirm:true)` | browse, read and remove snippets |
| `search(query)` | full-text search over both (every word must match) |
| `export_skill(name)` | mirror one skill natively for Claude Code and Codex (a one-item sync; `save_skill` already does this) |
| `sync_skills(dry_run?)` | mirror every skill natively and remove mirrors of deleted skills |
| `fleet_list` · `fleet_read(id, lines≤400)` · `fleet_usage` | read-only views of the SoA sessions and token spend |

Each skill is also an **MCP prompt**, so in Claude Code it shows up as
`/mcp__soa__<name>`. Skills and snippets are also **resources**:
`soa://skill/<name>` and `soa://snippet/<name>`. Over stdio, a save or a delete
sends `notifications/resources/list_changed` and
`notifications/prompts/list_changed`.

The server has no tool that types into a terminal, spawns or stops a session,
interrupts an agent or runs a command. `fleet_read` output comes from another
program's screen, so it is fenced as **UNTRUSTED** text and capped at about
100k characters.

## Store

```
$SOA_WEB_STATE_DIR/mcp/          (default ~/.soa-web-local/mcp, 0700)
  skills/<slug>/SKILL.md         0600
  snippets/<slug>.<ext>          0600
  index.json                     title, language, tags, created, updated, origin (cwd/tab)
  http-key                       0600, only created by `soa-mcp serve`
```

- Names are slugs: `[a-z0-9-]{1,64}` with no leading hyphen. The store refuses
  path separators, `..` and symlinks.
- Each item can be at most 256 KB, and the store holds at most 2000 items.
- Every write goes to a temp file that is renamed into place, under a short lock.
  The index is rebuilt from the files if it is ever lost.
- The store refuses content that looks like a credential: `sk-…`, `ghp_…`,
  `github_pat_…`, `AKIA…`, `-----BEGIN … PRIVATE KEY-----` or `xoxb-`/`xoxp-…`.
  Pass `allow_secrets:true` to store it anyway, and only for a deliberate,
  non-sensitive example. The content and the match are never logged.

## Presets

`mcp/presets/<pack>/` holds read-only packs that ship with the repo. Each pack
has a `pack.json` (`name`, `version`, `description`, `author`, `license`, and
optional snippet metadata), a `skills/` folder and a `snippets/` folder. The
first pack, `soa-basics`, teaches agents three things about working inside SoA:
claiming scopes with `soa-work` before editing, `soa-msg` etiquette, and
keeping the `soa-ctx` canvas current.

Presets are listed with `source: preset`, and the tools cannot delete or
overwrite them. If you save a user item with the same name, it shadows the
preset; delete your copy and the preset comes back. Run `soa-mcp presets` to
list the packs. Set `SOA_MCP_PRESETS_DISABLE=1` to hide them all.
`mcp/presets/README.md` explains how contributors can add a pack.

## Optional HTTP mode

```bash
soa-mcp serve --port 6083        # http://127.0.0.1:6083/mcp, Streamable HTTP, stateless
claude mcp add --transport http soa-http http://127.0.0.1:6083/mcp \
  --header "Authorization: Bearer $(cat ~/.soa-web-local/mcp/http-key)"
```

Binding to 127.0.0.1 is **not** enough on a SoA install. The daemon's
`/preview/<port>/` route forwards any loopback port through the public tunnel.
It rewrites `Host` to `127.0.0.1:<port>`, strips `Authorization`, and passes
the tunnel's forwarding headers and the browser's `Origin` through unchanged.
So the server answers a bare `403` unless all four of these hold:

1. the peer is a loopback socket, and `Host` is `127.0.0.1`, `localhost` or
   `[::1]` on **this** port (the same DNS-rebinding guard soa-dictate uses);
2. there are no proxy headers: no `X-Forwarded-*`, `X-Real-IP`, `Forwarded`,
   `Via`, `CF-*` or `x-soa-*`;
3. there is no `Origin`, or the `Origin` is this port's own loopback origin.
   A page served by the daemon on another port is refused;
4. the request carries `Authorization: Bearer <http-key>`. The preview proxy
   deletes that header, so a request that comes through it cannot authenticate.

`GET /mcp` returns 405, because the server opens no server-to-client stream.
For a launchd service, see `deploy/launchd/com.soa-web.mcp.plist`, which is
not installed by default.

## CLI

```
soa-mcp                 stdio server
soa-mcp serve [--port]  HTTP server (loopback only)
soa-mcp ls              everything in the library
soa-mcp show <name>     one item (skill:<name> / snippet:<name> to choose)
soa-mcp sync [--dry-run] [--json]   mirror skills into Claude Code + Codex
soa-mcp presets         preset packs
soa-mcp doctor          paths, counts, key status, registration, sync status
```

Environment variables: `SOA_WEB_STATE_DIR`, `SOA_MCP_PORT`,
`SOA_MCP_PRESETS_DIR`, `SOA_MCP_PRESETS_DISABLE`, `SOA_MCP_SYNC`,
`SOA_MCP_SKILL_PREFIX`, `SOA_MCP_CLAUDE_SKILLS_DIR`, `SOA_MCP_CODEX_SKILLS_DIR`,
`CODEX_HOME`, `SOA_MCP_CLAUDE_CONFIG` (the file doctor reads instead of
`~/.claude.json`), and `SOA_MCP_DEBUG=1`, which logs method names to stderr but never content.
