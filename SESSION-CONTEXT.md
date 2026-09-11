# Session context — SoA-Web

A durable record of what agent sessions in this repo found and changed, written
so the next session (or the next compaction) does not have to re-derive it.
Newest session first. Facts here were verified against the live machine at the
time; treat them as a starting point to re-check, not gospel.

---

## 2026-09-11 · Claude · the left-hand corruption, and batching the fleet's output

Two separate problems, one session. The first was the reported bug; the second
was the open question next to it.

### The corruption: the PTY and the emulator were different sizes

Measured on the live machine, not inferred: `__soaGrid` said the desktop's xterm
was **115x53**, and `stty -f /dev/ttys003 size` said the PTY behind that same tab
was **134x61**. The agent draws 134-column lines, xterm has 115 columns, so every
long line soft-wraps and the ~19-character tail lands in the LEFT-HAND columns of
the row below — on top of the text already there. That is the "drifts to the left
and obscures part of the left texts" the user reported, and the ragged left-edge
fragments in their screenshot are those tails.

**Root cause: the server resized the shared PTY to the MAX size any live client
wanted.** Written to stop a narrow phone clipping a wide desktop. But a terminal
emulator cannot show more columns than it has: the wide client is fine and every
narrower client gets corruption instead of a gutter. Two things made it stick:

- sizes were recorded **per socket per tab**, and recomputed only when a resize
  came IN. A window that had since closed went on pinning every PTY to its width
  forever — nothing ever recomputed on disconnect.
- the client only reports on CHANGE (xterm's `onResize` fires on change, and
  `_broadcastSize` tells a background tab its size exactly once), so switching to
  a stale tab never re-asserted anything.

The fix is the one every multiplexer already reached: **the smallest attached
viewer defines the grid** (`server/src/termGeometry.js`), a viewport belongs to
the SOCKET rather than to a tab (one terminal area on screen describes them all,
including tabs never visited), and geometry is recomputed at the three moments
the answer can change — an inbound resize, a tab becoming active, a socket
closing. The daemon then ANNOUNCES the result as `MSG.TERM_SIZE`, and the client
renders at that grid rather than at its own measurement.

The desktop now separates two numbers that used to be one: `_desired` (what this
window measured — reported up as a request) and `_authGrid` (what the PTY is —
what we draw at). Echoing an adopted grid back would ratchet it down to the
minimum a little further every round, so `_suppressReport` blocks that path. The
mobile client already worked this way; it only needed the new frame wired in.

Verified end-to-end against a scratch daemon on :7412 with real PTYs: two viewers
at 134x61 and 115x53 -> the PTY takes 115x53, **`stty size` inside the shell
agrees**, and when the narrow viewer disconnects the grid reopens to 134x61.

Note the cost this trades away: a viewer wider than the grid now has unused
columns on the right while a smaller one is attached. That is the "black void on
the right" the MAX rule was written to avoid. It is the right trade — a gutter is
cosmetic and self-explanatory, corruption is neither — and only the desktop
client declares a viewport at all, so attaching a phone never narrows anything.

### Responsiveness: the message count, not the bytes

Every chunk from every tab was its own WebSocket frame: a `JSON.stringify` on the
server, a `message` event and a `JSON.parse` in the browser, then the detector
pass. That is a fixed per-message cost paid once per chunk per tab, and it scales
with the number of running agents even though 21 of 22 terminals are not painted.

`server/src/termBatch.js` coalesces output into ONE `TERM_BATCH` frame per tick.
Latency is spent only where it shows: the tab on screen flushes on a 12ms window
(less than the rAF the client already coalesces xterm writes to), everything else
on 100ms, because nothing renders a background tab's bytes until you switch to
it. Opt-in per socket via `INPUT_KIND.CLIENT_CAPS`, so share viewers and any tab
still running the old bundle keep the original one-frame-per-chunk wire.

Measured on the scratch daemon, same shells, same bytes:

| tabs | frames/s before | after | |
|---|---|---|---|
| 12 | 51.1 | 10.1 | 5.0x fewer |
| 22 | 66.8 | 7.3 | **9.2x fewer** |

The ratio grows with tab count, which is the shape of the original complaint.

### Still open

- The desktop still runs its own `_detectAgentFromStream` per chunk per tab
  (`sb.recent += data` on every chunk, ~2 KB of garbage per tab) while the
  server's `sessionManager.feed` already derives the same status. One of the two
  is redundant.
- The per-chunk `audio.play('stdout', 'tab'+id)` fires for background tabs too.
- `.terms .xterm-screen { width: 100% !important }` makes the screen element
  wider than the canvas it contains (1052.93 vs 1045 measured). Harmless for
  paint; left alone rather than risk a selection/hit-testing regression.

---

## 2026-09-10 · Codex · terminal streaming follow-up

User confirmed the corruption happens **inside SoA only**, while output is
streaming. Codex's braille sparkle animation overwrites prompt/status text in
the supplied example. The working tree contains a tested follow-up patch;
it has not been committed, published, or loaded by restarting the live daemon.

### Corrections to the previous diagnosis

- **The same-value font assignment in #54 does nothing.** The exact shipped
  xterm 5.3.0 bundle emitted zero option events for `fontFamily = fontFamily`.
  Its OptionsService explicitly deduplicates equal values. The patch changes
  the family to an equivalent whitespace-suffixed value and restores it, which
  emits real option events. Hidden terminals defer this until visible. Both
  `document.fonts.ready` and later `loadingdone` events invalidate metrics.
- Canvas `measureText` measures a glyph, not the renderer's cell (which includes
  spacing and device-pixel rounding). Fit now uses the renderer's CSS cell size
  after invalidation; missing metrics keep replay queued instead of declaring
  a successful fit at the default grid.
- **Resize A → B → A within the debounce window left the PTY at B.** The
  equality shortcut returned before cancelling pending B. Cancellation now
  happens before deduplication, so a settled browser at A cannot send stale B.

### Streaming fixes in the working tree

- Deferred background snapshots could arrive AFTER live output, and include
  those same live bytes again. Reproduced `new → old → new`. New
  `server/src/terminalReplay.js` gates live terminal data per joining socket/tab
  until its snapshot is enqueued. Existing sockets and heartbeats keep flowing.
- Desktop HELLO/replay now replace old queues and terminal state on reconnect.
  The reset is queued as CAN + RIS with replay, preserving ordering with writes
  already accepted by xterm's asynchronous parser.
- Oversized single frames now respect the hidden replay cap; actual eviction
  is tracked separately from retained length, and truncated prefixes are
  cancelled and advanced to an ESC/newline boundary before parsing resumes.

### Validation and deployment state

- **187/187 `npm test` tests pass**, including 10 client regressions and six
  server replay cases. Client tests extract the actual TabRuntime class.
- Additional offline checks using the real xterm 5.3.0 bundle verified font
  option events and reconnect reset ordering, including a pending partial ANSI
  sequence. Syntax checks and `git diff --check` passed.
- `scripts/smoke-ws.js` passed against a separate daemon on port 7411 with state
  under `/private/tmp/soa-terminal-smoke-state`, using `/bin/sh` and no tunnel
  or agent auto-resume. No live fleet was exercised by that check.
- Live pid 94615 was still the daemon started **Sep 7 15:03:45**. A one-off
  loopback ping was <1ms; that does not rule out its documented periodic stalls.
  Server changes still require a deliberate restart that respawns live shells.
- Desktop entry asset bumped to `app.js?v=154`. Chrome was viewing `s0a.app`
  with a localhost backend, so publishing public static assets is distinct
  from serving this checkout at `http://127.0.0.1:4010`.

### Remaining limitations to check if corruption persists

- Multiple desktop viewers can still disagree with the shared PTY dimensions.
  Independent maxima combine 100×50 and 160×30 into 160×50; desktop xterm sizes
  itself locally and does not implement the claimed larger-grid scroll/scale.
  Disconnect also does not recompute the size. A full repair needs separate
  requested viewport and authoritative PTY geometry, with replay dimensions.
  The mobile client currently sends no TERM_RESIZE, so two devices alone is not
  proof that this is the user's trigger.
- Raw capped ANSI replay cannot reconstruct all cursor/mode state lost from
  an earlier prefix, especially after resizing. A screen snapshot would be
  needed for exact restoration. Mobile/share reconnect behavior is unchanged.
- macOS cwd polling still uses synchronous per-tab `lsof`; its live stall cost
  was not measured in this follow-up.
- Codex 0.154.0 supports `--approve-for-me`, documented `tui.animations=false`,
  and locally verified boolean `tui.whimsy=false`. The binary contains a
  composer `sparkle.rs`; whimsy disabling those exact particles is an inference.
  A scoped next-launch workaround is
  `codex resume --last --approve-for-me -c tui.animations=false -c tui.whimsy=false`.
  No Codex settings were changed.

---

## 2026-09-07 → 2026-09-09 · tab #1 `app` · session `6321e8b7`

Continuation of the session below. Two threads: a long hunt for terminal lag
and layout corruption, and a run of UI work (clock, settings, skins). 20 PRs
merged, #33–#52.

### The thing to read first

**The daemon reads its source once, at startup.** It has been up since
`Sep 7 15:03:45`, and the ReDoS fix in #16 landed on disk at `16:17:15` — 74
minutes later. So for two days the running daemon executed the *buggy*
quadratic launch-marker regex while the fix sat on disk, git clean, version
correct, doing nothing. Measured effect: `/api/ping` over loopback at **p50
2441ms, p90 6726ms, max 10283ms**, against 1–2ms when healthy. Everything
downstream — bursty output, shredded layout, "the page freezes" — follows from
an event loop that stalls for seconds.

This trap is now automated: `scripts/soa-version-nag` (#51) compares the newest
mtime under `server/src` against the daemon's own start time from
`ps -o lstart` and pushes a phone notification when they disagree. A source file
written after the process booted is a file that process has never read.

**Still outstanding at the end of this session:** the restart. It loads #16
(ReDoS), #21 (UTF-8 locale), #50 (measured context %). Nothing else is blocked
on anything.

### Terminal performance — the whole chain, in the order found

Each of these was real and each was measured, but note the ordering lesson: the
first eight are client-side and none of them was the dominant cost.

| # | Cause | Evidence |
|---|---|---|
| #18 | xterm was using its **DOM renderer** — no renderer addon was loaded | `canvases: 0` |
| #19 | `.xterm-viewport` pinned to `overflow: hidden`, so no compositor scrolling and no trackpad momentum | wheel became whole-line main-thread jumps |
| #19 | ctx poll scanned every dirty tab at 2Hz (~66 row→string translations each) | every tab is dirty when every agent is producing |
| #22 | the globe ran a full-rate three.js loop whenever the sidebar was visible | its own comment calls it "pure decoration" |
| #32 | `queueReplay` rebuilt a 128 KB string on **every chunk** once past its cap | ~21 background tabs × every chunk |
| #32 | `_detectDevServer` ran four regex passes, each allocating a copy, on all output from all tabs | gated now by `indexOf('http')` |
| #32 | `_detectEffort` re-derived a badge from a 2 KB window per chunk, unthrottled | moved below the existing throttle |
| #32 | `allowTransparency` forced per-cell compositing | reverted; bands use `mix-blend-mode: screen` instead |
| #34/#36 | one xterm write per WebSocket chunk → batched per frame; then two bugs in that batching (typing was batched like scrolling; rAF never fires in an occluded window) | |
| #47 | Time Machine read **every tab's whole buffer synchronously** every 5 min | 22 tabs × ~1000 `translateToString` + JSON + IDB write |
| #52 | **`_broadcastSize` sent every size change to every tab** — one resize became 22 SIGWINCHes and 22 full TUI repaints | scales with tab count, which matched the reported "getting worse" |

### The cell-width bug — SOLVED at #54, after five wrong attempts

**Root cause: xterm measures its cell ONCE, when the terminal opens, and caches
it.** At that moment the web font (Fira Mono) has usually not loaded, so it
measures the fallback and keeps that number for the life of the page. Every
later fit then divides the container by a cell width the renderer is not
drawing with, and the grid stops short. There is no public re-measure call, but
**assigning a font option invalidates the cached metrics**, so a no-op
`term.options.fontFamily = term.options.fontFamily` after `document.fonts.ready`
makes it measure again with the real face.

The reason this took five attempts is that **every source of truth I reached for
was also lying**, each in a different way:

| Source | Said | Why it lied |
|---|---|---|
| xterm internals (`dims.css.cell.width`) | ~11.9px | the stale pre-webfont metric |
| canvas ÷ cols | 7.2px, then 9px | **a feedback loop** — the canvas is sized *from* the grid, so whatever column count the fit last chose is always "confirmed". The same 756px canvas gave 7.2px at 105 cols and 9px at 84: two stable, wrong fixed points |
| `getComputedStyle(.xterm)` font | 15.17px | measures the **page** font — `.xterm` inherits the display face (16px United Sans), not the terminal's |
| `term.options` font | **7.83px** | what xterm was actually constructed with — the truth |

Measured after the fix: `cols 97, cell 7.83px, gap 3px` (sub-cell), from
`84 cols, cell 9px, gap 6px`.

**Two rules worth keeping.** Never derive a measurement from something that is
itself derived from the value you are computing — check for the loop first. And
`getComputedStyle` on an xterm element tells you about the page, not the
terminal; `term.options` is the only honest source for what it is rendering in.

The PERF widget now reports `GRID` and `GAP` so the terminal states its own
geometry (`97x46 · cell 7.83px` / `3px`, GAP red past two cells) instead of it
being inferred from screenshots — which is how half a day was spent.

### The earlier, superseded attempts at the same bug

#### (kept for the reasoning, not the conclusion)

The right-hand black strip and the layout tearing share one root: **xterm
reports a cell width it does not paint with.** Measured on the live dashboard:
container 1214px ÷ 102 cols = **11.9px per cell**, against a painted cell of
**7.2px** (probably a stale metric from before the web font, or a device-pixel
value at 2× DPR).

Three fixes failed because they were all *fallbacks* — they only ran when
xterm's lookup returned **nothing**, and a lookup that returns a **wrong**
number sails through. The fix that worked (#46) makes the **paint
authoritative**: the painted grid is exactly `cols × cellW`, so dividing it
gives the truth, and xterm's number is believed only when it agrees within 5%.

Then #48 removed FitAddon from the path entirely. It was sizing the grid from
that same wrong metric, so every fit did **two** resizes — wrong, then
corrected — and each is a SIGWINCH that repaints Claude's whole TUI. With the
2-second fit guard re-firing on divergence it never stopped. `fitNow` now
measures the container, derives the cell from paint (`_cellSize`), and resizes
once.

**Rule for the future: measure what is on screen, not what the library says is
on screen.**

### Context %, status and token accuracy (#50)

Every context reading in the product came from the **client scraping a
percentage out of Claude Code's footer** and reporting it up via `CTX_REPORT` —
tab badges, the FLEET bar, `sessionManager`'s high-context checks, the usage
throttler. Claude Code no longer prints that line, so the whole chain reports
`null`.

Replaced with a measurement: every transcript record carries that request's
usage, and `input + cache_read + cache_creation + output` **is** the context it
was holding, so the newest record in a session is its live context size
(verified: `2 + 703,438 + 280 + 744 ≈ 704k`). The window is inferred — a context
past 200k proves a 1M model. Client polls `/api/claude-usage` every 15s and maps
by cwd; when the field is absent it no-ops and the old scrape still runs, so the
rollout is safe in either order.

**Do not confuse the two token quantities.** `sessions[].block.tok` is
cumulative spend across every request (hundreds of millions); `ctxTokens` is
what the model is currently holding. They were being read as if they meant the
same thing. The cost model itself is fine — cache reads have their own rate and
scale factor, not charged as fresh input.

### The machine, not the code

At the end of this session the Mac itself was the binding constraint:

```
load average 25.95 on 18 cores
git pack-objects  92%   (a repack of ~/Desktop/whop-dev)
git index-pack    90%   (a fetch --recurse-submodules)
  parent: git log --oneline -S "…"   ← a pickaxe search over the monorepo
OrbStack Helper   65%
WindowServer      46%
```

The SoA daemon was **2.5%** and each Claude agent 3–4%. No frontend change is
visible under a load average of 26. Check `uptime` before believing a
performance report.

### UI work shipped

Clock (#37–#42): two faces, digital and an SVG dial; a ⚙ secondary menu for
face, hour format and cities; local plus every city as identical fixed-width
cells in **one row** that never wraps; the day offset shown only when it changes
the answer. Cells are fixed at 46px — `flex: 1` tied their size to sidebar width
and tab count, which is how two cities became two balloons.

Settings (#39): the panes were a three-column table headed KEY / DESCRIPTION /
VALUE — a config file in HTML. Now one row per decision: human name leading, key
demoted, description in the quiet tone, every control in one right-hand column.
Booleans became segmented ON/OFF switches writing through a hidden input, so
every existing `get('set-x').value === 'true'` save path is untouched. **All
seven tabs audited functional**, including a save round-trip.

Skins (#43–#45): MINIMAL and LIQUID had none of the session's new components.
The tokens carried the palette across automatically — which is why nothing
*looked* broken — but anything encoding an assumption about the palette or
geometry failed silently. Two real breakages: the transcript band tinted with
the accent and screen-blended it, and MINIMAL's accent is ink, so it was
invisible there; and the band overlay was positioned to TRON's terminal padding
in every skin. **MINIMAL also had no dark mode** — it overrode the palette
unconditionally. Added one, after first rewriting thirty hard-coded
`rgba(34,37,43,…)` values into `--m-ink-rgb`/`--m-card` so the dark block is a
palette swap and duplicates no rules.

Also: a recovery panel for when the daemon disappears (#15, holds back 8s, live
retry countdown, escalates at 45s); conversation bands in the terminal (#23–#29,
history only, never the composer or the queued-message box — the discriminator
is that a sent turn's caret is in column 0 while Claude's own chrome indents
it); turn navigation with Ctrl/Cmd+Shift+Up/Down (#49); and the **PERF widget**
(#33), which reports FPS, blocked main-thread ms/s, stream rate and a
per-subsystem breakdown. `BLOCKED` is the discriminator: high means JavaScript,
near-zero with low FPS means paint. It named `xterm write` correctly.

### Techniques that paid off

- **`stty -f /dev/ttysNNN size`** on the daemon's child shells is ground truth
  for what the client told each PTY. `ps -axo ppid=,tty=` maps them.
- **Timing loopback `/api/ping` in a loop** measures the daemon's event loop
  directly. p50 in milliseconds is healthy; seconds is a blocked loop.
- **CPU tells you which kind of stall**: pegged means computing (a regex),
  ~2% while stalling means blocked (I/O, or a long synchronous read).
- The agent browser participates in the fleet: **PTY size is the MAX across
  live clients**, so a headless client at a different size is a real
  participant. Detach it (`soa-browser open …/api/tabs`) when not measuring.
- The agent browser runs `--disable-gpu` and pins rAF near 24fps, so **no frame
  rate measured there means anything**. That is why the PERF widget exists.

### Still open

1. **Restart the daemon** — loads #16, #21, #50. Everything else waits on it.
2. **Tag `v0.3.0`** after the restart has proven the server half. 41+ commits
   since `v0.2.0`, and `soa-selfupdate` tracks release tags, so every other
   install is still on `v0.2.0` including the ReDoS fix.
3. **Kill the git pickaxe/repack** and consider pausing OrbStack.
4. **Bind tab → Claude session via the Stop hook** — the canvas still resolves
   by cwd, so tabs sharing a directory get a neighbour's transcript (wrong
   prompts, missing artifacts). Same gap makes the new ctx% mapping pick the
   most recently active session per cwd.
5. **#44 (LIQUID canvas/recovery/bands) was never visually verified** — the
   agent browser would not boot at the time.
7. The terminal now sits **flush** in both skins (#54): MINIMAL was spending
   12–14px of gutter plus the same again in padding, LIQUID ~10px per axis, to
   frame a surface already distinct by tone. Tone and a hairline radius stay.
   Band overlays were realigned to the new padding — if a skin's `.term`
   padding changes again, `.term-bands` inset must follow it.
8. `index.html` asset versions (`?v=`) were static across ~15 JS changes, so
   neither side could tell what a page was running. All bumped at #54; bump
   them when editing assets.
6. `scripts/soa-version-nag` is loaded on this machine as
   `gui/503/com.soa-web.version-nag`; the repo copy of the plist still uses the
   canonical `/Users/test/.soa-web` paths.

### Machine facts added this session

- **uid 503**; launchd label `app.s0a.web.local`; logs `~/.s0a-local/logs`.
- **`notify.json` did not exist** — no push on this machine could reach the user,
  including the usage alerts. Created at `~/.s0a-local/state/notify.json`
  (chmod 600) with an ntfy topic; delivery verified end to end.
- CSS/JS are served with `?v=` plus `max-age=0` and an ETag, so edits reach the
  browser on reload — a stale asset is not a plausible explanation for "nothing
  changed"; an unreloaded page is.

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
