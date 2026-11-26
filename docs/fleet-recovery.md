# Fleet recovery — tabs, agents and sessions

How SoA-Web brings the fleet back after a daemon restart, how to check it came
back right, and how to repair a tab by hand when it did not.

The rule this whole path enforces: **every tab comes back as the same agent
(Claude or Codex) on the same conversation it had, and no conversation is ever
attached to two tabs.** On 2026-11-25 a restart broke that: `tabs.json` held no
session ids, so restore guessed from each tab's cwd. Twelve Codex tabs came
back as Claude, one Claude conversation was resumed into up to ten tabs, and
the `|| claude --continue` / `|| codex resume --last` fallbacks attached other
tabs' threads.

## What is persisted

Every tab entry carries:

| field | meaning |
|---|---|
| `cwd` | the tab's shell directory (also its grouping and title base) |
| `title`, `userRenamed` | the title only when a person chose it (`rename`); auto and dedupe labels (`Side-Proj-1`) are re-derived, never frozen |
| `agent` | `claude` \| `codex` \| `null` |
| `sessionId` | the exact thread the agent is on, observed or launched, **never a cwd guess** |
| `sessionCwd` | the directory that thread belongs to (Claude finds a session only from the project it was created in, and that can differ from the tab's cwd, e.g. tab `Side-Proj`, conversation `Side-Proj/pisnp`) |

These fields are in every copy a restore can read: `tabs.json`, the protected
`tabs.json.lastgood`, the `tabs.json.bak-*` ring and the per-tab meta in
`scrollback.json`, all in the state dir. `reconcileTabsFromScrollback()` (boot
self-heal, including suspect-tombstone recovery) and
`fleetRestore.pickSource()` keep them. A `sessionId` without a known `agent` is
dropped, because a Claude id given to Codex fails, and so does the reverse.

## Where identity comes from (the tty/ps ground truth)

1. **Launch.** `sessionManager.launchClaude` stamps `agent`, `sessionId` and
   `sessionCwd` on the tab when it resumes a known id (a saved or recorded
   one, `exact`), never for a cwd guess.
2. **Observation.** `sessionIdentity` reads the process table (one `ps` for the
   whole fleet): the first `claude` or `codex` process under each tab's PTY is
   that tab's agent, and its argv (`claude --resume <id>`,
   `codex resume <id>`) or Claude's own registry (`claude agents --json`, which
   maps a pid to the conversation it is in now) gives the thread. Codex has
   no such registry, but a running `codex` holds its own rollout file open
   (`~/.codex/sessions/…/rollout-<ts>-<uuid>.jsonl`), so one `lsof -c codex`
   gives every Codex tab its live thread too, including a bare `codex` and a
   `/resume` inside the TUI (`sessionIdentity.codexOpen`, merged into the
   same pid map; `SOA_WEB_CODEX_LSOF=0` turns it off). index.js runs
   this sweep every 30 s (`SOA_WEB_IDENTITY_SWEEP_MS`). The registry is called
   at most every 2 min (`SOA_WEB_IDENTITY_REGISTRY_MS`), and the sweep writes
   to disk only when something changed.
   The live process wins over a remembered id. A tab whose agent changes kind
   drops the old id. An agent that has exited leaves its id on the tab, because
   the next resume needs it. A *new* process of the same kind with no readable
   id (a bare `claude` started by hand, a fresh `codex`) clears it:
   `tab.sessionPid` records which process the id belongs to (`'launched'`
   until our own launch is first seen). The periodic `ps` is async, so it
   never stalls the terminals; a thread's `sessionCwd` is looked up at the next
   launch, not in the sweep.
3. **Shutdown and crash.** `shutdown()` and `crashFlush()` run one final
   synchronous stamp before the final `saveAll` and `freeze`, with a fresh
   `claude agents --json` (≈3 s cap; the cache only if that fails, and a cache
   older than 10 min is not used). The PTYs are about to die, and their
   command lines die with them; a `/resume` in the last two minutes is only in
   a fresh registry answer.

A thread handed out by the allocator (below) is **not** identity: it is typed
into the tab but stamped only when the sweep sees the process on it. A wrong
guess persisted as identity would be resumed exactly on every later restart.

The screen-paint detector (`❯` vs `›`) only labels the row. It no longer
rewrites `tab.agent` for a tab whose kind was observed or launched.

## How a restore relaunches each tab

Restore-on-connect / boot-resume (`index.js scheduleAutoResume`) and
`POST /api/fleet/restore` (`fleetRestore.restoreFleet`) share
`fleetRestore.allocate` + `launchAll`:

0. **What is already open** (`tabPersist.planRestore`). A live tab on an
   entry's saved thread (in any session) consumes that entry. Only entries
   with no saved thread are matched by cwd, as a multiset. A bare shell, or a
   tab on another thread, never swallows a saved identity.
   The Time Machine sends only `{cwd, title}`; the daemon fills each tab's
   identity from `tabs.json` / `lastgood` (cwd multiset, skipping threads that
   are live) and keeps a title only when it is not the basename or a
   `<basename>-N` label. That rule also unfreezes auto labels an older restore
   saved with `userRenamed: true`.
1. **Identity pass.** A tab with `agent` + `sessionId` keeps them, unless a
   live tab or an earlier saved entry already holds that id. The loser keeps
   its agent, loses the id, and stays a shell: it is not handed another thread.
2. **Allocation**, only for tabs with no id: the newest recent thread of the
   tab's agent for its cwd that no tab (saved or live) has claimed. When the
   agent is unknown, the newer transcript of the two agents decides. When
   nothing is left, the tab stays a shell.
3. **Launch line** (`sessionManager.agentLaunchLine`), exactly one of:
   ```sh
   claude --resume <id>
   codex resume <id> -c check_for_update_on_startup=false
   (cd '<sessionCwd>' && claude --resume <id>)     # thread lives elsewhere
   ```
   Restore chains nothing behind the id: no `--continue`, no `--last`, no
   cold start. A resume that fails leaves the shell. (A manager `spawn` may add
   `|| claude` / `|| codex`, a cold start of the *same* agent.) Codex tabs never
   get a `claude` command, and Claude tabs never get a `codex` one. The
   subshell keeps the tab's own cwd. Ids and models are validated, and the
   directory is single-quoted.

The manager verbs `soa-sessions resume` / `continue` go through the same
allocator for the whole cohort (`sessionManager.relaunchLines`): a tab's own
thread exactly, otherwise a distinct unclaimed one, otherwise no line (the
target reports `left at its shell`). They never type `--continue` / `--last`.

## Checking a restore: `/api/fleet/audit`

About 25 s after a restore's last launch (`SOA_WEB_RESTORE_AUDIT_MS`), the
daemon runs one sweep and logs:

```
fleet-audit: 14 tab(s) · 1 missing · 12 ok · 1 wrong-session · 0 duplicate id(s)
fleet-audit:   #7 wrong-session expected claude:fd99cf1d observed claude:01a0dbf3
```

The same report on demand (it runs a sweep now; `?last=1` returns the last
scheduled one instead):

```bash
curl -s http://127.0.0.1:4010/api/fleet/audit | jq '{summary, duplicates, bad: [.tabs[] | select(.status != "ok" and .status != "shell")]}'
```

Status per tab: `ok`, `wrong-agent`, `wrong-session`, `missing` (a thread was
expected but only the shell is running), `unverified` (the right agent, but its
thread could not be read: Claude's bare process title and no registry answer
yet), and `shell` (nothing expected and nothing running). `duplicates` lists
any thread that is live in two tabs. That list must be empty.

Both the scheduled and the on-demand audit ask Claude's registry afresh (it
is the only source of a Claude thread id); when it cannot answer, the summary
says `claude registry unavailable`. What a restore *meant* (`restoreExpect`)
is judged once, by the audit scheduled for that restore, and then retired;
after that a tab is compared against its own current identity, so moving a tab
to another thread later (or repairing it by hand) does not keep it flagged.

The plain loopback `curl` above needs no cookie: a local caller is let through
without being given a session (which would overwrite `session.json`). A remote
caller needs the usual pairing auth. Neither needs an entitlement.

Ground truth by hand, for one tab (`<pty pid>` from `soa-sessions list` or
`ps`):

```bash
ps -o pid,ppid,command -g "$(ps -o pgid= -p <pty pid>)"
claude agents --json | jq '.[] | {pid, sessionId}'
```

## Restarting the daemon: `soa-restart`

The standard restart is one command. It is the 2026-11-25 manual recovery as
a procedure, and it replaces a raw `kill -TERM` / `launchctl kickstart`:

```bash
scripts/soa-restart              # snapshot, restart, wait, audit, repair
scripts/soa-restart --dry-run    # print the identity snapshot; restart nothing, write nothing
scripts/soa-restart --no-repair  # restart and audit only
```

1. **Find the live daemon**: the state dir from `SOA_WEB_STATE_DIR` or the
   `daemon.lock` whose pid is alive; the port from the lock (`--port`); the
   label from `--label`, `SOA_WEB_LAUNCHD_LABEL` or `app.s0a.web.local`.
2. **Snapshot identity** into `<state>/session-hints.json` (saved tab order).
   The source is `GET /api/fleet/audit` (the observed agent and thread per
   tab). An older daemon without that endpoint is read from the process table
   instead: its PTY shells (children of the daemon pid), matched to the tabs in
   `tabs.json` by a cwd unique among the tabs and among the shells
   (`/proc/<pid>/cwd` on linux, `lsof -d cwd` elsewhere). A cwd shared by
   several tabs gets no hint: shells are in spawn order and tabs in saved
   order, so after a drag two same-cwd tabs would swap threads. The id comes
   from the agent's argv, or `claude agents --json` by pid for a bare `claude`.
3. **Restart through the supervisor**: `launchctl kickstart -k gui/<uid>/<label>`
   (`systemctl --user restart <label>.service` on linux). That is a SIGTERM, so
   `shutdown()` stamps and flushes. A `tabs.json` flushed after the hints wins
   over them; the hints fill only tabs it has no id for, and take over when
   the list is older (a crash, or old code that wrote no ids).
4. **Wait** for a new pid in `daemon.lock` and `/api/ping` (90 s), then for the
   restore's scheduled audit (`GET /api/fleet/audit?last=1` with
   `scheduled: true`, newer than the restart, 120 s; `SOA_RESTART_AUDIT_WAIT_MS`).
   `?last=1` returns only an audit a restore scheduled; before that it is an
   ad-hoc sweep, which the CLI does not take as the restore's verdict (it would
   see tabs whose staggered launch has not fired yet as `missing`). Requests get 60 s and retries:
   a loaded daemon has taken 14 s to answer a GET.
5. **Audit and repair**: a fresh audit, a table of every row that is not ok,
   then `POST /api/fleet/repair` (below) and one more audit.

Exit codes: `0` every tab ok, unverified or shell; `2` mismatches remain
(`wrong-agent`, `wrong-session`, `missing`, or a duplicate); `1` no live
daemon, or the restart itself failed; `3` restarted, but the new daemon has no
`/api/fleet/audit` (the install dir was not mirrored?), so nothing was audited
or repaired. The outcome is also written to `<state>/soa-restart.last.json`
(`{at, code, result}`). Run from inside a tab, it re-runs itself detached (the
restart kills that tab's shell), logs to `<state>/logs/soa-restart.log`, and
exits 0 at once — the real exit code is only in that file.
`SOA_RESTART_DRY=1` never calls launchctl/systemctl (it prints the command)
and sends the repair as `{"dryRun":true}`; it still writes
`session-hints.json` (applied by a boot within 30 min) and the status file.
That is what the tests use.

The dashboard's MORE → restart (`/api/daemon/restart`) writes the same hints
file from the tabs' current identity before it kickstarts, so a restart whose
shutdown flush never happens (a hard kill, a crash on the way down) starts from
the observed ids too.

## Automatic repair: `POST /api/fleet/repair`

The manual repair below, as one call. Same gate as the audit (loopback, or the
pairing auth; no entitlement):

```bash
curl -sX POST http://127.0.0.1:4010/api/fleet/repair -H 'content-type: application/json' \
     -H "x-soa-tab: $SOA_WEB_TAB" -d '{"dryRun":true}'
curl -sX POST http://127.0.0.1:4010/api/fleet/repair -H 'content-type: application/json' \
     -H "x-soa-tab: $SOA_WEB_TAB" -d '{"ids":[7]}'
```

It runs a fresh audit and acts only on a tab whose status is `wrong-agent`,
`wrong-session` or `missing` **and** whose expected identity is exact: a
restore's exact id (`restoreExpect.exact`, kept past the audit while the tab is
broken), or, for `missing`, the tab's own recorded id. An allocated guess is
never acted on, and neither is a live agent that differs from the tab's
remembered id with no exact restore behind it (that is the user's own switch,
which the sweep adopts). It never touches the manager tab, the caller's own tab
(`x-soa-tab` header — send it from a tab, as above, or the repair may kill
the agent that asked), or a tab that is `ok`, `unverified` or `shell`. It
refuses outright when `ps` failed (every tab would read `missing`), skips a
claude `wrong-session` read without the registry (argv only), and skips a tab
whose launch is still in flight (due less than 20 s ago,
`SOA_WEB_REPAIR_GRACE_MS`: `missing` there means "still starting").

First every planned tab is stopped, then each is launched, one at a time with
a 1.5 s stagger (stop all, then launch: in a swap a launch before the other
tab is stopped would put two processes on one transcript):

1. Re-check the tab: if the process in front is no longer the one the audit
   judged (for `missing`: an agent has started), it changed since the audit
   and is skipped. Otherwise SIGTERM the foreground agent under the tab's PTY
   and re-check every 2 s (`SOA_WEB_REPAIR_POLL_MS`), SIGKILL from the 7th
   try, give up after 10. A `|| fallback` agent that starts is stopped too.
   The shell is never signalled, and it must end with NO child: a vim, a
   REPL or an ssh in front is not a prompt, and the tab is skipped.
2. Launch only when no other tab still runs the thread and the shell is still
   idle: Ctrl-U, then the exact launch line (`agentLaunchLine`: the thread's
   own directory in a subshell, no `--continue` / `--last`, the codex flag).
   A restore's own delayed launch that finds an agent already in front does
   not type.
3. ~10 s after the last launch (`SOA_WEB_REPAIR_VERIFY_MS`), one re-audit
   fills each row's `after`.

Duplicates: a thread is never resumed into a tab while it stays live in a tab
that is not being repaired, and never into two tabs. The tab that owns the
thread keeps it; another tab on it is repaired only if it has an exact id of
its own, else it is reported (`action: "left"`). The reply is
`{ok, results: [{id, before, action, after, line?, why?}], summary}`, and the
daemon logs one `fleet-repair:` line. One repair runs at a time (a second call
gets 409).

`SOA_WEB_RESTORE_AUTOREPAIR=1` (off by default: it kills processes in live
tabs) makes the restore's scheduled audit call the repair itself for
`wrong-agent` / `wrong-session` rows.

## Manual repair of one tab

Use this when the audit shows `wrong-agent`, `wrong-session` or a duplicate,
and you know which thread the tab should be on. The thread's directory is in
`tabs.json` (`sessionCwd`), in the first `"cwd"` of
`~/.claude/projects/*/<id>.jsonl`, or in the first `"cwd"` of
`~/.codex/sessions/**/rollout-*-<id>.jsonl`.

1. **Stop the foreground agent until only the shell is left.** Find its pid
   under the tab's PTY (above) and send `kill -TERM <agent pid>`. Repeat if a
   fallback in the old chain starts another one. Do not kill the shell: that
   closes the tab.
2. **Clear the prompt line**: send Ctrl-U (`soa-sessions say <tab> $'\x15'`).
3. **Start the right agent on the right thread**, from the thread's directory,
   with nothing chained behind it. The subshell keeps the tab's own cwd:
   ```bash
   soa-sessions send <tab> "(cd '<sessionCwd>' && claude --resume <id>)"
   soa-sessions send <tab> "(cd '<sessionCwd>' && codex resume <id> -c check_for_update_on_startup=false)"
   ```
   `soa-sessions say` / `send` need the Fleet Manager entitlement (they return
   403 on an unlicensed install). Without it, type the same keys into the tab
   from the dashboard or the phone, or use the tab API, which is not
   entitlement-gated (it does need the dashboard's session cookie, since a
   cookieless local call is given a new session):
   ```bash
   curl -sX POST -b "<cookie>" http://127.0.0.1:4010/api/tabs/<tab>/keys -H 'content-type: application/json' -d '{"text":"\u0015"}'
   curl -sX POST -b "<cookie>" http://127.0.0.1:4010/api/tabs/<tab>/exec -H 'content-type: application/json' \
        -d "{\"line\":\"(cd '<sessionCwd>' && claude --resume <id>)\"}"
   ```
4. **Confirm** with `ps` (the agent's argv carries `<id>`) or with
   `curl -s http://127.0.0.1:4010/api/fleet/audit`. The next 30 s sweep stamps
   the tab, and `tabs.json` follows.

Never fix a duplicate by resuming the same id in the second tab. Give that tab
its own thread, or leave it a shell.

## The upgrade restart (first boot onto identity-aware code)

The daemon that shuts down to install this code runs the old code, which
writes no `sessionId` and often no `agent`. Without help, that first boot
restores by the cwd guess. Two ways to avoid it:

1. **Hints file, written just before the restart.** Put
   `session-hints.json` in the state dir:
   ```json
   {"savedAt": 1764100000000, "tabs": [{"cwd": "/abs/tab/cwd", "agent": "codex", "sessionId": "<uuid>"}, …]}
   ```
   `tabs` is in the same order as `tabs.json` (`agent` defaults to `claude`).
   Boot applies it once (by position, confirmed by cwd; a cwd that is unique
   on both sides may match out of position), then renames it `.applied`.
   A file older than 30 min is ignored. To find the ids: each tab's agent
   process carries its tab number in its environment
   (`ps -E -o pid,command -p <pid>` shows `SOA_WEB_TAB=<n>`); a Codex id is in
   its argv (`codex resume <id>`), and a Claude id comes from
   `claude agents --json` (pid → sessionId).
2. **Audit and repair afterwards.** Run `/api/fleet/audit` once the restore
   has settled, and fix the tabs it flags with the manual repair above. After
   that first boot every tab carries its identity, and later restarts are
   exact.

`soa-restart` does both. Against the old daemon it has no `/api/fleet/audit`,
so the snapshot comes from the process table (step 2 above) and the hints file
carries the ids. The new daemon applies them on its first boot, audits, and
`soa-restart` then calls `/api/fleet/repair` on the new code. The old daemon's
`/api/daemon/restart` writes no hints, so use `soa-restart` for that one
upgrade, not the MORE menu.
