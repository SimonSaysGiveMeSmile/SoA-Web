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

## Your context canvas (soa-ctx)

The dashboard's right-hand **CONTEXT** panel is a per-session canvas, not a
read-only view of chat history — and the agent in the tab is one of its authors.
It is scoped to the Claude session that owns the current directory, so there is
nothing to look up:

```bash
soa-ctx                          # the whole canvas: workspace, recent prompts, artifacts, next steps
soa-ctx json                     # the same payload, for scripting
soa-ctx steps                    # the NEXT STEPS list
soa-ctx step add "ship the migration"   # queue a step  (also: done <n> · rm <n> · clear)
soa-ctx artifacts                # published artifacts
soa-ctx artifact <url> [title…]  # register one you just published
```

Four bands: PROMPTS (your turns, from `history.jsonl`), WORKSPACE (dir, branch,
session, path), **ARTIFACTS**, and NEXT STEPS. Artifacts fill in **by default** —
the daemon reads published `claude.ai` artifact URLs out of your own transcript,
so a URL you printed once is on the canvas whether or not you announced it.
Register one explicitly when you want the title to read well, or when the URL
never got printed. Next steps seed from `TodoWrite` and are then yours (and the
user's) to edit; the saved list always wins.

Use it as the durable surface between turns: what you produced and what is left,
in a place the user can see from their phone and you can read back with one
command.

## Restoring a lost fleet

If the tabs vanish (empty dashboard, `soa-sessions list` nearly empty), the
context is almost always still on disk — the daemon keeps `tabs.json`, a
protected `tabs.json.lastgood`, a rotating ring of `tabs.json.bak-*`, and
`scrollback.json`, all in the state dir. The recovery is one call, and it is
non-destructive (it only ever OPENS tabs):

```bash
curl -sX POST http://127.0.0.1:4010/api/fleet/restore \
     -H 'content-type: application/json' -d '{}' | head -c 400
```

That runs `server/src/fleetRestore.js`, which is the workflow the fleet has been
rebuilt with by hand three times: pick the richest surviving list (tabs.json →
lastgood → newest backup → the cwds inside scrollback.json), drop entries whose
directory is gone, skip cwds that are **already open counting duplicates as a
multiset** (three tabs on one repo must restore three tabs), open the rest, and
resume each one's Claude conversation with a **distinct** recent session id so
two agents never attach to the same transcript. The dashboard's Time Machine
Restore button calls the same endpoint, and the endpoint is not
entitlement-gated — recovering your own terminals is not premium fleet control.

Two things that have caused a real loss, worth knowing:

- A `closedByUser` tombstone in `tabs.json` (written when a session legitimately
  closes every tab) makes boot-time self-heal respect the "intent" and skip
  recovery. If the fleet is down and `tabs.json` is a lone tab, check for that
  flag before assuming the state is gone.
- `soa-sessions spawn` needs the Fleet Manager entitlement, so on an unlicensed
  install the old `soa-restore-fleet` path fails. `/api/fleet/restore` does not.

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
soa-sessions meet start <room> --with <cohort> [--title T] [--mode round|free]
                                        # convene a group meeting (see soa-meet below)
soa-sessions meet end <room>            # adjourn it
soa-sessions meet rooms | meet who <room>   # every room · one room's roster
```

A **cohort** is `all` or a signal name — `attention`, `stuck`, `idle`, `done`,
`working`, `highContext`, `limited` — or `meeting:<room>` (everyone currently in
that group meeting), or a comma-list of ids. Your own tab is auto-excluded from
every fan-out and hidden from your own event stream, so you never trigger or
command yourself — including from `meet start`: a manager *convenes* a meeting,
it doesn't sit in one. So you are **not** a member of a room you started, and
`soa-meet say` there is refused (`NOT_MEMBER`, exit 3). To take part as well as
chair, `soa-meet join <room>` first; otherwise let the user speak from the
dashboard or phone and just watch with `soa-meet read <room>`.

**Convert a user desire into per-session goals**: decompose it in *your* context
into concrete per-project objectives; `spawn` a tab (with `--goal`) for each
project that isn't open yet, `goal <cohort> …` the rest, and keep the mapping in
your notes. On `attention` answer routine prompts with `send`/`goal`, else
`soa-msg` the user **one** question. On `stuck` → `read`, then `btw`/`compact`,
or `interrupt`+`resume` if wedged. On `done` → assign the next goal. On
`highContext` → `compact`. On `limited` → it auto-resumes (or `resume-all`).
Prefer `goal`/`btw` over raw `send` so the slash-prefix is correct; never bare
`claude` after a restart (use `resume`). Keep your own running notes as context.

### Token-usage control — throttle, never stop

The manager also keeps the fleet under Claude's usage limit so agents don't burn
the 5h/weekly quota and get `limited` (which *stops* their work). Live spend is a
first-class input: `soa-sessions usage` reads the same v2 engine the dashboard
shows and folds it per **project** (and `--by session`), tab-correlated, with a
`$/min` burn rate and budget verdicts:

```bash
soa-sessions usage                 # per-project 5h$ / day$ / $/min + OVER/FAST flags + a ⚠ THROTTLE header
soa-sessions usage --by session    # per-session detail
soa-sessions usage --over          # just the over-budget tab ids (comma-list, for fan-out)
soa-sessions usage --ids hot       # over-budget OR burning fast (the throttle set)
soa-sessions list --cost           # the normal fleet view + a spend column
soa-sessions budget set <project> <blockCost> [todayCost]   # per-project caps ($ est.; default 20/5h · 60/day · 1.5/min)
```

When a project is **OVER** budget or **FAST**, or the 5h block is projected to
blow the limit, **THROTTLE — never `stop`** (stopping loses the work; the goal is
to slow burn, not halt it):

```bash
soa-sessions throttle <id|list|over|hot|all>            # /compact each → clears context → cheaper turns, work continues
soa-sessions throttle <id|hot> --pause [Nm]             # interrupt + auto-resume in Nm (default 15): pauses burn, resumes itself
```

Policy: prefer **`/compact`** (safe — the agent keeps working, just at a lower
per-turn cost; best on high-context tabs). Use **`--pause`** only for the
*fastest* burners when the block is close to the cap — it interrupts the current
turn and schedules a `continue`, so nothing is ever abandoned. **Never `stop`**
an agent to save tokens. Re-check `usage` after throttling; on `limited` the tab
still auto-resumes at the reset. Thresholds live in
`~/.soa-web-local/usage-budgets.json` (defaults mirror the `soa-usage-alert`
push watchdog and the dashboard's ⚠ hot-row highlight, so all three agree).

## Agent-to-agent comms (soa-bus)

`soa-bus` is a **local-only** message bus so agents can coordinate directly
instead of only through the manager. It is pure append-only JSONL under the
state dir (`~/.soa-web-local/a2a/`) — it **never touches the network, is never
uploaded, and is never shared off this machine**. No database, no daemon.

```bash
soa-bus post   <channel> <msg>          # publish to a shared channel
soa-bus read   <channel> [--since MS] [N]   # last N (default 50)
soa-bus dm     <id|title> <msg>         # direct message to one agent
soa-bus inbox  [--since MS] [--watch]   # your direct messages
soa-bus watch  <channel> [--once]       # BLOCK until new traffic, then print it
soa-bus channels                        # list active channels
soa-bus whoami                          # your bus identity (#id title)
```

Identity is auto-derived from `soa-sessions whoami` (`#<id> <title>`), so
messages are attributed to the sending tab. Use it to hand off work between
projects (post a contract/decision to a shared channel), request something from
a peer (`dm`), or make an agent **event-driven** on a channel (`watch` blocks at
≈0 CPU until a peer posts — the A2A analog of `soa-sessions watch`). Keep
messages short; channels are size-capped and trimmed to the tail.

## Group meetings (soa-meet)

`soa-meet` is a **local-only groupchat**: the user (as manager) puts themselves
and a few agents in ONE room, and every line anyone says is relayed to the others
— so separate Claude instances actually answer *each other* instead of talking
past each other. The transcript rides the `soa-bus` substrate
(`~/.soa-web-local/a2a/meet-<room>.jsonl`), so the same guarantee holds: pure
append-only JSONL that **never touches the network, is never uploaded, and is
never shared off this machine**. The daemon is the single writer.

```bash
soa-meet say   <room> <msg…>            # your turn — ONE line, ≤2 sentences
soa-meet read  <room> [--since MS] [N]  # the transcript (non-blocking)
soa-meet rooms                          # every room, open first (+ msgs left, hops n/max)
soa-meet who   <room>                   # the roster + who is reachable
soa-meet join  <room> | leave <room>    # add / excuse yourself
soa-meet watch <room>                   # BLOCKS — never use this (see rule 1)
soa-meet whoami                         # your identity + the ledger path
```

You are **woken, not waiting**: when a room has something new for you, the 3s
supervisor types one brief into your terminal with the recent lines already
inlined (`[meeting standup] 2 new · you're up. RECENT: …`), so answering costs one
prompt and no catch-up tool call. You are never poked mid-turn, at a permission
prompt, or while rate-limited — the room simply waits a beat. Two rules follow
from this, and both are load-bearing:

1. **NEVER block in `soa-meet watch`.** You are woken by a line typed into your
   terminal, so there is nothing to wait for — and blocking means your Claude turn
   never ends, the Bash tool call times out, and the whole room stalls behind you
   waiting on a member that can no longer answer. `watch` refuses to run inside a
   tab for exactly this reason. To catch up, `soa-meet read` (non-blocking).
2. **Reply with ONE `soa-meet say` of at most two sentences, then STOP.** It is a
   groupchat, not a memo: lines are hard-capped at **280 characters** (longer ones
   are truncated mid-thought), and every line you say costs every other member a
   Claude turn. Say your piece, end your turn, let the room move.

Pacing is structural: agents may answer each other for `SOA_MEET_RELAY_MAX` (2)
rounds and then the room goes **QUIET** until the user speaks again, because only a
HUMAN message recharges the relay budget — so silence after your line means it is
the user's turn, **not** that you were missed; never retry into a quiet room
(`soa-meet rooms` shows `hops n/max`, and `say` prints `[QUIET]` when the budget is
spent). A refusal — adjourned room, not a member, budget spent — prints `[REFUSED]`
and exits **3**, so "no" is distinguishable from "broken". Limits are env-tunable:
`SOA_MEET_RELAY_MAX` (2 relay rounds) · `SOA_MEET_POKE_MS` (8s per-tab poke
cooldown) · `SOA_MEET_MSG_BUDGET` (40 lines, then the room adjourns) ·
`SOA_MEET_IDLE_MS` (5m with no human line → adjourn) · `SOA_MEET_MAX_MEMBERS` (6) ·
`SOA_MEET_RECENT_K` (4 lines inlined per brief) · `SOA_MEET_MSG_CAP` (280) ·
`SOA_MEET_CHAN_PREFIX` (`meet-`) · `SOA_MEET_DRY=1` (print, send nothing).

## Not stepping on each other (soa-work)

`soa-work` is a **local-only work-claim ledger** built on the `soa-bus` substrate
(same privacy: pure append-only JSONL under the state dir, never networked) so two
agents never blindly edit the same directory tree or shared asset. **Before any
multi-file edit, refactor, or commit that touches shared or ambient state**, run
the claim → check → release loop:

```bash
soa-work check   <scope>                          # conflict? exit 3 + who holds it · clear? exit 0
soa-work claim   <scope> [--ttl 30m] [--note "…"] # register it for the duration
soa-work beat    <scope>                          # keep a long job's claim fresh
soa-work release <scope>                          # the instant you finish — and before going idle
soa-work ls                                       # every live claim (who owns what)
soa-work conflicts                                # all live overlaps (manager view)
```

`<scope>` is the **narrowest** thing you'll modify: an absolute path (your repo
root or a subtree — overlap is by **ancestor/descendant**, so a claim on
`…/Summer-2026` collides with `…/Summer-2026/iPlan` in *both* directions) or a tag
like `asset:@macncheese/desktop-ui` / `project:anthropic-proxy` (exact match). If
`check` reports `[CONFLICT]`, do **not** proceed — narrow to a non-overlapping
subdir, `soa-bus dm #<id> "coordinating on <scope>?"` the owner, or ask the
manager; never double-edit a claimed scope. Claims are **advisory** (the non-zero
exit is the signal; nothing is force-locked) and **self-expire** (default 30m TTL,
and a crashed/exited agent's claims are reaped immediately via the fleet snapshot),
so a forgotten release only blocks briefly — but release promptly so peers aren't
stalled. Make yourself event-driven on peers' claims with
`soa-bus watch work-events --once` (never bare `watch`). The manager runs
`soa-work conflicts` in its loop and heads off overlaps before assigning goals.

## Driving an isolated browser

`soa-browser` controls a headless Chromium the server manages (separate from the
user's real Chrome); its live view streams into the SoA BROWSER panel:

```bash
soa-browser open https://example.com
soa-browser eval "document.title"
soa-browser screenshot out.jpg
```

`soa-browser open|click|type|key|scroll|back|eval|url|screenshot`.

## Shipping a change (CI/CD)

Tests run in GitHub Actions on every PR and every push to `main`
(`.github/workflows/ci.yml`: `npm ci`, a syntax sweep over `server/src` and the
node CLIs, then `npm test` on node 20 + 22). `main` is protected — changes land
through a PR, not a direct push.

A release is cut by tagging a commit that is already on `main`:

```bash
git checkout main && git pull
git tag -a v0.2.0 -m "v0.2.0" && git push origin v0.2.0
```

`.github/workflows/release.yml` re-runs the suite on the tagged commit, then
publishes a GitHub Release with generated notes and a source tarball. Nothing is
published that did not pass.

**The daemon updates itself from those releases.** `scripts/soa-selfupdate`
(launchd job `com.soa-web.selfupdate`, every 30 min) tracks the newest `v*` tag:

```bash
soa-selfupdate --check        # what's available, change nothing
soa-selfupdate                # fetch + preflight + stage; restart only inside the window
soa-selfupdate --now          # apply and restart immediately
soa-selfupdate --channel main # track origin/main instead of releases
```

Five properties make it safe to leave running: it updates the checkout the LIVE
daemon is running (read from the process's own command line, not guessed); it
refuses to touch a dirty working tree; staged code must pass `node --check` on
every server source **and** the full test suite before a restart is considered;
restarts are windowed (`SOA_UPDATE_WINDOW`, default 03:00–05:00) because a
restart respawns every tab's shell; and a restart that can't be verified rolls
back to the previous commit and restarts again. Kill switch:
`SOA_UPDATE_ENABLE=0`.

For a change you want live **now**, `soa-deploy` is still the direct path
(mirror → `kickstart -k` → prove the new pid is serving the new code). Static
client files under `web/public/**` only need a reload.

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
6. `com.soa-web.nudge-stale-4010` — every **900s (15 min)** runs
   `scripts/soa-nudge-stale` (FLEET-CONTINUE): keeps the whole fleet moving.
   Finds PARKED tabs (idle/done/attention/stuck) that still carry an UNFINISHED
   Claude Code todo list — todo state read from the on-disk task store, **not**
   the terminal: per tab cwd → newest `~/.claude/projects/<enc(cwd)>/<sid>.jsonl`
   → `~/.claude/tasks/<sid>/*.json` (one file per task, `status`
   pending|in_progress|completed), reliable even after the widget scrolls off.
   Then: a tab that just stopped → types `continue`; a tab **waiting on a
   decision** (attention/stuck, or a question in its tail) → a fast headless
   `claude -p` (haiku) reads its context + todos and **AUTONOMOUSLY makes the
   best call**, typing the answer in (a digit for numbered menus). It does NOT
   escalate to the user (per standing directive — see memory
   `fleet-autonomy-decide`). Guardrails: prefer safe/reversible actions; never
   auto-authorize spending money, deleting data, or destructive deploys, and for
   human-only secrets (API keys/logins) tell the agent to proceed with all
   non-blocked todos and defer that item. Skips manager tabs + caller; ~14m
   per-tab cooldown; a tab making NO progress backs off to hourly (never
   abandoned). Log: `~/.soa-web/logs/nudge-stale.log`.
7. `com.soa-web.effort-4010` — every 900s runs `scripts/soa-effort`: keeps every
   agent at `/effort ultracode` (xhigh effort + standing dynamic-workflow
   orchestration). ultracode is **session-only** — it resets to the settings.json
   default (`xhigh`) on restart/resume — so this re-asserts it. Requires
   `enableWorkflows: true` in `~/.claude/settings.json` (else `/effort ultracode`
   errors "needs dynamic workflows enabled"); the script warns if it's off. Only
   touches PARKED tabs (never interrupts a working agent); detects current effort
   from the footer (the word `ultracode`) and skips tabs already set; ~20m per-tab
   cooldown. Log: `~/.soa-web/logs/effort.log`.
8. `com.soa-web.usage-alert` — every 120s runs `scripts/soa-usage-alert`: polls
   `/api/claude-usage` (loopback, no auth) and pushes the user when a SINGLE
   session is "using too much token" — leaning hard on the model in the active
   5h usage-limit block (≥ $20 est.), heavy today (≥ $60), or suddenly burning
   fast (cost-**velocity** ≥ $1.5/min, derived by diffing successive polls; the
   piece the stateless snapshot engine lacks). Edge-triggered with a 30-min
   per-session cooldown (never spams), re-fires on a 2× escalation, resets on a
   new block. Correlates each Claude session → tab (`#N title`) via `/api/tabs`.
   Delivers via `soa-notify` (ntfy OS push) + in-app CHAT. Read-only over
   loopback — never touches the daemon/tabs/agents; **no restart needed**.
   Thresholds env-tunable (`SOA_USAGE_BLOCK_COST`/`_TODAY_COST`/`_BURN_COST`/
   `_COOLDOWN`). The dashboard TOP SESSIONS widget flags the same sessions with a
   ⚠ red row. Log: `~/.soa-web/logs/usage-alert.log`.
9. `com.soa-web.fleet-loop` — a PERSISTENT daemon (KeepAlive, not a timer) running
   `scripts/soa-fleet-loop`: blocks on `soa-sessions watch` (≈0 CPU between events)
   and reacts the INSTANT a session changes state — the always-on complement to the
   manager AGENT's event loop (works even with no manager alive) and to the timer
   watchdogs. SAFE BY DEFAULT: journals every event (the only persistent fleet-event
   log) + notifies you on `limited` (an agent hit its cap and stopped) and an
   unexpected `exited` (a working agent's process died), each with a 30m per-tab
   cooldown; skips the manager tab; NEVER interrupts a working agent or stops
   anything. Immediate high-context `/compact` of PARKED tabs is OPT-IN
   (`SOA_FLEETLOOP_COMPACT=1` in the plist; usage-throttle otherwise owns compaction).
   Kill switch `SOA_FLEETLOOP_ENABLE=0`; dry-run `SOA_FLEETLOOP_DRY=1`. On a watch-
   stream end launchd restarts it (5s sleep guards against hot-looping). Log:
   `~/.soa-web/logs/fleet-loop.log`.

The old `:7332` jobs (`com.soa-web.server`, `com.soa-web.watchdog`,
`com.soa-web.manager-watchdog`) were retired on 2026-06-28 (their logs end
then; the `-4010` replacements were installed minutes later) and are
launchctl-**disabled**; their plists remain in `~/Library/LaunchAgents` but
must **not** be re-enabled. To stop the daemon by hand, bootout
`com.soa-web.watchdog-4010` **first** (else it revives the daemon). Action
logs: `~/.soa-web-local/logs/watchdog.log` (watchdog) and
`~/.soa-web/logs/heartbeat.log` (heartbeat).
