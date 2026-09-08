# Session context — SoA-Web

A durable record of what agent sessions in this repo found and changed, written
so the next session (or the next compaction) does not have to re-derive it.
Newest session first. Facts here were verified against the live machine at the
time; treat them as a starting point to re-check, not gospel.

---

## 2026-08-31 → 2026-09-07 · tab #1 `app` · session `6321e8b7`

Working directory `~/.s0a-local/app`, branch `main`. One continuous thread:
**the dashboard was misreporting its own state in five different places**, plus
a fleet recovery at the start.

### Environment facts that contradict CLAUDE.md

CLAUDE.md describes a different install than the one running here. These were
verified directly and cost real time to discover:

| CLAUDE.md says | This machine actually |
|---|---|
| Repo at `/Users/test/Desktop/Hireal/soa-web` | `~/.s0a-local/app` |
| State dir `~/.soa-web-local` | `~/.s0a-local/state` (the former does not exist) |
| Install dir `~/.soa-web`, mirror edits into it | No mirror step — the daemon serves this repo directly |
| Logs in `~/.soa-web/logs` | `~/.s0a-local/logs/{out,err}.log` |
| Five launchd jobs (watchdog, manager-watchdog, channels, heartbeat, …) | **Only `app.s0a.web.local` is loaded.** No watchdog. |

Consequences worth remembering:

- **No mirror, no restart for client changes.** `web/public/**` is served off
  this checkout, so a merge + `git pull` *is* the deploy; a browser reload picks
  it up. Only `server/src/**` needs a daemon restart.
- **The dashboard registers no service worker** (the SW is mobile-only, in
  `web/public/m/sw.js`), so there is no cache version to bump for dashboard work.
- **`soa-sessions` refuses to run here** — "the Fleet Manager feature is not
  enabled for this install." Use the HTTP API instead: `/api/tabs`,
  `/api/fleet/restore`. Both work unauthenticated over loopback.
- Self-healing is **one layer, not five**: launchd `KeepAlive` on the daemon
  alone. A daemon that is up but not answering will not be killed and restarted
  by anything, because the watchdog job is not installed.

### Fleet recovery (the thing that started it)

The tab list had collapsed to one. Recovery was one non-destructive call:

```bash
curl -sX POST http://127.0.0.1:4010/api/fleet/restore \
     -H 'content-type: application/json' -d '{}'
```

Returned `from: lastgood` and brought back all 19 tabs. A second call returned
`opened: []`, `skipped: [19 cwds]` — proof it was complete. `opened`/`skipped`
are **arrays**, not counts.

### Shipped

Every change went out the same way: branch → PR → CI green on node 20 + 22 →
`gh pr merge --squash --delete-branch` → `git pull` into this checkout.

| PR | Commit | What was actually wrong |
|---|---|---|
| #10 | `9271fa1` | Two controls for the context canvas. Removed the topbar `◧ CTX` button; reworked the surviving pull tab, which was an opaque 15px slab parked on top of the terminal's last two columns, into a grip mark on the panel border that fills in on hover/focus/touch. |
| #11 | `327095b` | Only the **active** tab ever sent a `TERM_RESIZE`, so 15 of 19 PTYs sat at the `120x32` spawn default. The settled grid is now broadcast to every tab (coalesced 250ms; re-sent on reconnect, since the server tracks desired sizes per socket). |
| #12 | `d927959` | The real "black slab": `_fillWidth` read the cell width from `core._renderService.dimensions.css.cell.width`. When that lookup misses, FitAddon's `proposeDimensions` misses with it and `fit()` silently no-ops, freezing the grid. Measured live: `{container: 1220, grid: 734, gap: 486}` — 102 columns painted into a 169-column box. Now falls back to `paintedGridWidth / cols`, and may shrink as well as grow. |
| #13 | `5738377` | Every Time Machine snapshot recorded `cwd: null`, so every row said `view only` and REBUILD was skipped — `rebuilt 0` forever. `_tabCwd` was filled only from the WS `SNAPSHOT` message; `HELLO` carries `cwd` and `mem` per tab and was throwing them away. |
| #14 | `684d096` | Copying prompts out of the CONTEXT panel dragged the turn number and age in with the text. `.ctx-turn-m` is now `user-select: none`. |
| #15 | `cb30ad0` | Losing the daemon was reported as one red word. Added a recovery panel (8s hold-back, live retry countdown, escalates to manual steps at 45s, commands built from the connected address with copy buttons, not a modal) and `RECOVERY.md`. `bridge.js` now emits `attempt` and `retryIn` on the status event. |

Landed from other agents during the same window: #4 `7b72f47` (delegating tab
state), #6 `8a510b2` (brace-expansion CVE), #16 `566c6b1` (see below).

### #16 — the one that explains the outages

`fix(agent-tasks): stop the launch-marker regex backtracking the daemon to a halt`

`agentTasks.js` (from #4) had `LAUNCH_RE = /([^\s"'\\]*\/tasks\/…)/g`. The
leading class matches `/` too, so on any long unbroken token it went quadratic.
Transcripts here carry ~600 KB runs with no whitespace (one pasted base64 image
does it). 164 KB of tail took 46s; a 4 MB backfill extrapolates to hours of
blocking regex inside the 4-second sampler. The daemon accepts connections on
`:4010` and answers nothing → restart loop → `install.sh` refuses to run.

**The trap this exposes, which will recur:** the daemon reads code only at
startup, so it can be healthy in memory while the code on disk is broken. When
this was found, the daemon had 2h08 uptime and was fine; `agentTasks.js` on disk
had an mtime *later* than the daemon's start time and carried the bug. The
machine was armed — any restart, including launchd's own `KeepAlive` after a
crash, would have loaded it. **Compare daemon start time against the mtime of
`server/src/*.js` before concluding that "it's working fine" means anything.**

```bash
ps -o pid=,lstart=,etime= -p "$(pgrep -f 'server/src/index.js' | head -1)"
stat -f '%Sm %N' server/src/*.js
```

### Diagnosed but not fixed

- **Mouse-report flood** (`35;52;12M…` streaming into a shell as input). SGR
  mouse reports: `Cb=35` = 32 (motion) + 3 (no button) ⇒ DEC private modes
  **1003** (any-event tracking) + **1006** (SGR encoding) left armed by a dead
  TUI. Per-tab clear:
  `printf '\033[?1000l\033[?1002l\033[?1003l\033[?1006l\033[?1015l\033[?1049l\033[?2004l\033[?25h'`
  The repo's own mitigation is `SANE_TERM_RESET` (`server/src/index.js:86`),
  used when seeding a fresh shell and when replaying the graveyard. Note:
  **restoring an old Time Machine snapshot can re-arm this**, because replay
  writes saved scrollback back into the terminal.

- **Artifacts missing from the context canvas.** `contextCanvas.js` resolves a
  tab's Claude session from `~/.claude/history.jsonl`, which records only
  `{project, sessionId}` — **the cwd, never the tab**. With four tabs on
  `~/Desktop/whop-dev`, they all bind to whichever session prompted last, so a
  tab gets a neighbour's transcript: wrong prompts, and its own published
  artifact invisible. Proven: `aa147002…jsonl` (what the canvas read) had
  `artifacts=0`; `3aa96e46…jsonl` (the tab that actually published) had the URL.
  The extraction regex is fine.
  **`lsof` cannot fix this** — Claude appends to the transcript and closes it,
  holding nothing open. The workable route is the existing Stop hook, which
  knows both `$SOA_WEB_TAB` and the session id, registering the pair for the
  canvas to read instead of guessing. Server-side, so it needs a restart.

- **Shared-PTY sizing trade-off.** `server/src/index.js:1160` resizes the shared
  PTY to the **largest** size any live client wants, to stop a phone clipping
  the desktop. The cost is that a narrower client then renders a PTY wider than
  its own grid. Real tension, not a bug; left alone.

### Techniques that worked

- **`soa-browser` against the live dashboard.** It drives a headless Chromium
  the daemon manages, fixed at 1024×768. `soa-browser open http://127.0.0.1:4010/`
  then `eval` for DOM measurements, `screenshot` for design review. **Detach it
  when done** (`soa-browser open http://127.0.0.1:4010/api/tabs`) — while it has
  the dashboard open it is a second client and shows up in the device count.
  Below 1100px the context panel becomes an overlay, so its geometry is not
  representative of a wide desktop.
- **Reading PTY geometry from outside**: map the daemon's children to ttys and
  ask the kernel. This is ground truth when the client and server disagree.
  ```bash
  DPID=$(ps -axo pid=,command= | grep -m1 '[s]erver/src/index.js' | awk '{print $1}')
  ps -axo pid=,ppid=,tty= | awk -v d="$DPID" '$2==d'
  stty -f /dev/ttys009 size    # → "rows cols"
  ```
- **`~/.claude/history.jsonl` as forensic evidence.** Every prompt is stored
  verbatim, so a pasted clipboard can be recovered exactly — that is how the
  CONTEXT-panel copy bug was proven (`…(down\r\r22\r3d\rchange bracket to…`).
- **Screenshot, crop, enlarge** for design review: `sips -c H W --cropOffset Y X`
  then `sips -Z 480`.

### Still open

1. Bind tab → Claude session via the Stop hook (fixes the artifact/session
   mismatch above). Needs a daemon restart, which respawns all 19 shells —
   deferred to the 03:00 self-update window rather than interrupting live agents.
2. Optionally install the watchdog job from `deploy/launchd/` so a daemon that
   is up-but-silent gets restarted. Not installed on this machine.
3. Tab #1 is titled `app` — auto-derived from the cwd folder name, so it
   describes a location and not a role. Renaming is one call to
   `PATCH /api/tabs/:id`.

### Artifact watches held by this session

Session-local, so they die with it. Watching: `Clone Run Timelines`,
`Agent Run Autopsy`, `Whop Engineering Record`, `Cloning happywags.co`,
`Artifact Smoke Test`. All five are also registered on this tab's context canvas
(`soa-ctx artifacts`).

### Standing preferences observed

- Finished work ships without being asked: branch → PR → wait for CI → squash
  merge → pull. `main` is protected; a direct push is rejected.
- Concise commit and PR bodies.
- UI work gets a design pass (`frontend-design`) before it lands.
