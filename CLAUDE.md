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

Edit this repo (`/Users/test/Desktop/Hireal/soa-web`), then mirror changed files
to the install dir (`~/.soa-web`). Static client files (`web/public/**`) take
effect on reload (bump the SW `VERSION` in `web/public/m/sw.js`). Server changes
(`server/src/**`) need a graceful restart: `kill -TERM <daemon-pid>` (flushes
scrollback/tabs, leaves the tunnel running) then
`launchctl kickstart -k gui/$(id -u)/com.soa-web.server`. The tunnel URL is
persisted to `~/.soa-web/tunnel.json` and re-adopted across restarts, so it
stays stable.

## Self-healing (no more manual restores)

The prod daemon is supervised so it comes back on its own — see
`deploy/launchd/`. Two layers: (1) the `com.soa-web.server` launchd job uses
**unconditional `KeepAlive`** (any exit → restart in ≤10s; the old conditional
form left a clean exit-0 dead, which was the recurring "please restore"); (2) a
`com.soa-web.watchdog` job runs `scripts/soa-watchdog` every 60s, pinging
`/api/ping` and `kickstart -k`-ing the daemon if it's **hung or down** (the case
KeepAlive can't see). On restart the daemon re-adopts the tunnel + persisted
tabs. The watchdog only touches `com.soa-web.server`/`:7332` — never the product
instance (`:4010`/`~/.soa-web-local`). To stop the daemon by hand, bootout the
**watchdog first** (else it revives the daemon). Action log:
`~/.soa-web/logs/watchdog.log`.
