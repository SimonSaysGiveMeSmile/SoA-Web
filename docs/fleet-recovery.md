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
   maps a pid to the conversation it is in now) gives the thread. index.js runs
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
