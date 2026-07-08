# SoA-Web — agent notes

This repo runs **Son of Anton** (SoA-Web): a browser-native terminal that streams
PTY sessions over WebSocket, with a mobile companion at `/m/` paired over a
Cloudflare tunnel.

## Talking to the user (mobile IM)

The user often watches from their phone via the mobile **CHAT** view. You can
message them there directly — it shows up as a chat bubble (and is spoken aloud
if they have speech on):

```bash
soa-msg "Deploy finished — all green."
soa-msg "Need a decision: keep the old API or migrate now?"
echo "piped status" | soa-msg
```

Use it to send a short status update, ask a question, or flag that you need
input while you keep working — not just at the end of a turn. Keep messages
brief (the IM trims to ~50 words). The user's typed replies arrive in your
terminal as normal input.

Note: when you finish a turn, your final message is **automatically** sent to
the IM (via a Claude Code Stop hook), so you don't need `soa-msg` for that —
reach for it for *mid-task* updates and questions.

## Managing the whole fleet (manager agent)

SoA runs many sessions (tabs), each often a Claude agent. A **manager agent** is
just a dedicated session whose job is to oversee the others. It has its own
context, and `soa-sessions` gives it full read/act access to every other session:

```bash
soa-sessions list                 # all sessions: status, context %, NEEDS-INPUT/STUCK/HIGH-CTX flags
soa-sessions read <id> [lines]    # recent output of a session (read its "context")
soa-sessions send <id> <text>     # type text + Enter into a session (answer a prompt, give a task)
soa-sessions say  <id> <text>     # type without Enter
soa-sessions compact <id>         # run /compact on a session that's high on context
```

A server-side supervisor watches every tab always-on (status + context + stuck
detection) and feeds the dashboard's FLEET bar; `soa-sessions list` reads the
same view.

### React, don't poll — the event loop

A manager agent is **event-driven**, not a busy-poller. The supervisor emits a
trigger whenever a session changes state, and the manager *blocks* on a
long-poll until one arrives (≈0 CPU between events):

```bash
soa-sessions whoami               # confirm YOUR tab id (never command/stop your own id)
soa-sessions events               # one-shot drain to reconcile current state
soa-sessions watch [--kinds attention,stuck,done,limited] [--once]
                                  # BLOCKS until the next event(s), then prints them
```

Event kinds: `attention` (needs input), `stuck` (working but silent >4m),
`done`, `idle`, `working`, `highContext` (ctx ≥80%), `limited` (hit usage limit),
`spawned`, `exited`. Each is a one-line wake-up like
`[ev 142] #3 "api" attention (was working) ctx 41%`. **`list` is ground truth;
events are advisory wake-ups** — if `watch` reports `dropped > 0` you slept
through history, so reconcile with `list`.

The loop: `whoami` → `events`+`list` (reconcile) → forever block on `watch` →
for each event, `read` the offending session, decide, and act:

```bash
soa-sessions goal <id|cohort> <text>    # fan a /goal out to one tab or a cohort
soa-sessions btw  <id|cohort> <note>    # /btw aside
soa-sessions clear <id|cohort>          # /clear
soa-sessions resume <id|all|limited>    # claude --resume … || claude --continue
soa-sessions broadcast <cohort> <text>  # plain-text nudge to a cohort
soa-sessions interrupt <id>             # Ctrl-C to unwedge a stuck agent
soa-sessions spawn [<cwd>] [--title T] [--goal "…"] [--model m]   # START a new agent
soa-sessions stop <id>                  # STOP an agent (refuses your own tab)
```

A **cohort** is `all` or a signal name — `attention`, `stuck`, `idle`, `done`,
`working`, `highContext`, `limited` (or a comma-list of ids). Your own tab is
auto-excluded from every fan-out and hidden from your own event stream, so you
never trigger or command yourself.

**Convert a user desire into per-session goals**: decompose it in *your* context
into concrete per-project objectives; `spawn` a tab (with `--goal`) for each
project that isn't open yet, `goal <cohort> …` the rest, and keep the mapping in
your notes. On `attention` answer routine prompts with `send`/`goal`, else
`soa-msg` the user **one** question. On `stuck` → `read`, then `btw`/`compact`,
or `interrupt`+`resume` if wedged. On `done` → assign the next goal. On
`highContext` → `compact`. On `limited` → it auto-resumes (or `resume-all`).
Prefer `goal`/`btw` over raw `send` so the slash-prefix is correct; never bare
`claude` after a restart (use `resume`). Keep your own running notes as context.

## Driving an isolated browser

`soa-browser` controls a headless Chromium the server manages (separate from the
user's real Chrome); its live view streams into the SoA BROWSER panel:

```bash
soa-browser open https://example.com
soa-browser eval "document.title"
soa-browser screenshot out.jpg
```

`soa-browser open|click|type|key|scroll|back|eval|url|screenshot`.

## Deploy model

The production instance is the **consolidated daemon**: launchd label
`app.s0a.web.local`, port `:4010`, code `~/.soa-web/server/src`, static
`~/.soa-web/web/public`, state dir `~/.soa-web-local` (`SOA_WEB_STATE_DIR`).

Edit this repo (`/Users/test/Desktop/Hireal/soa-web`), then mirror changed files
to the install dir (`~/.soa-web`) — that is the code the live daemon runs (it
reads code only at startup). Static client files (`web/public/**`) take effect
on reload (bump the SW `VERSION` in `web/public/m/sw.js`). Server changes
(`server/src/**`) need a graceful restart: `kill -TERM <pid>` — read the pid
from `~/.soa-web-local/daemon.lock` — (flushes scrollback/tabs) then
`launchctl kickstart -k gui/$(id -u)/app.s0a.web.local`; tabs and tunnel
re-adopt. The tunnel URL is persisted to `~/.soa-web-local/tunnel.json` (the
**state dir**, not `~/.soa-web`) and re-adopted across restarts, so it stays
stable.

## Self-healing (no more manual restores)

The supervision plists are tracked in `deploy/launchd/` in the **canonical
repo** (`/Users/test/Desktop/Hireal/soa-web/deploy/launchd/`; the install dir
`~/.soa-web` has no copy, and the daemon's own `app.s0a.web.local.plist` lives
only in `~/Library/LaunchAgents`). Layers of supervision (all `gui/501`
launchd jobs):

1. `app.s0a.web.local` itself has unconditional **`KeepAlive = true`** — any
   exit → restart in ≤10s. On restart the daemon re-adopts the tunnel +
   persisted tabs.
2. `com.soa-web.watchdog-4010` — every 60s runs `scripts/soa-watchdog`: pings
   `:4010` and `kickstart -k`s `app.s0a.web.local` if it's **hung or down**
   (the case KeepAlive can't see). It is load-tolerant — it re-probes over
   ~30s before acting, so a load-starved (not dead) daemon isn't restarted —
   and runs with `SOA_WEB_MANAGE_TUNNEL=0` so it never touches the tunnel.
3. `com.soa-web.manager-watchdog-4010` — every 90s ensures a manager tab
   exists (resumes a wedged one, respawns it if missing).
4. `com.soa-web.channels` — every 60s owns/heals the public tunnel
   (provider-agnostic: it has switched between cloudflare and ngrok) and
   persists the active channel (`tunnel.json`/`channels.json` in the state
   dir).
5. `com.soa-web.heartbeat` — every 600s produces the fleet blocker digest.

The old `:7332` jobs (`com.soa-web.server`, `com.soa-web.watchdog`,
`com.soa-web.manager-watchdog`) were retired on 2026-06-28 (their logs end
then; the `-4010` replacements were installed minutes later) and are
launchctl-**disabled**; their plists remain in `~/Library/LaunchAgents` but
must **not** be re-enabled. To stop the daemon by hand, bootout
`com.soa-web.watchdog-4010` **first** (else it revives the daemon). Action
logs: `~/.soa-web-local/logs/watchdog.log` (watchdog) and
`~/.soa-web/logs/heartbeat.log` (heartbeat).
