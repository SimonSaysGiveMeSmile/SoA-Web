# If the dashboard goes dark

**Nothing is lost.** Your terminals do not live in the browser tab — they are
real shells running on your Mac, and every tab's directory and scrollback is
written to disk. A blank dashboard almost always means one thing: the page can't
reach the server for a moment. The shells are still there.

This page is the whole recovery, from "wait a second" to "rebuild the fleet by
hand". Work down it in order and stop as soon as the dashboard comes back.

The dashboard shows you most of this itself: once the connection has been down
for about eight seconds a panel appears in the bottom-right with these steps and
a copy button on each command. This file is the longer version, and the one you
can still read when there is no dashboard to open.

---

## 0. What just happened

| What you see | What it means |
|---|---|
| `disconnected` in red, bottom-right | The page lost its WebSocket. The server may be fine. |
| Terminals frozen but visible | You are looking at the last frame the page received. |
| Dashboard loads but has one tab | The server restarted and hasn't re-adopted your tabs yet. |
| Browser can't open the page at all | The server is genuinely down. |

## 1. Wait about a minute

macOS supervises the server and restarts it on its own. The page retries on a
backoff and reconnects the moment the server answers — you do not have to reload
anything.

The panel in the dashboard counts the retries out loud (`attempt 3, next try in
4s`) so you can see it is still working rather than guessing.

## 2. Ask whether the server is up

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4010/
```

- **`200`** — the server is healthy and only your browser tab is stuck. Reload
  the page.
- **`000` or a hang** — nothing is listening. Continue to step 3.

## 3. Start it again

```bash
launchctl kickstart -k gui/$(id -u)/app.s0a.web.local
```

Run this in the macOS **Terminal** app, not in a SoA tab — the SoA tabs are
children of the very process you are restarting.

Give it ten seconds, then reload the dashboard. Tabs and the public tunnel URL
re-adopt themselves; the tunnel address stays the same across restarts.

If `launchctl` says the service is not loaded:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.s0a.web.local.plist
```

## 4. Tabs missing after it comes back

```bash
curl -sX POST http://127.0.0.1:4010/api/fleet/restore \
     -H 'content-type: application/json' -d '{}'
```

This is the same thing the dashboard's **Time Machine → Restore** button calls.
It is **non-destructive: it only ever opens tabs, never closes one**, so running
it twice is safe — the second run comes back with an empty `opened` and skips
everything already live.

It picks the richest surviving record of your fleet, drops any entry whose
directory no longer exists, skips directories that are already open (counting
duplicates, so three tabs on one repo restore as three tabs), opens the rest,
and resumes each one's Claude conversation with its own transcript.

A healthy response looks like:

```json
{"ok":true,"from":"lastgood","opened":[...],"skipped":[...]}
```

`opened` and `skipped` are lists, so `opened` empty and `skipped` holding every
directory means there was nothing left to do — the fleet is already whole.

`from` tells you which record it used, in order of preference:

| Source | What it is |
|---|---|
| `tabs.json` | The live tab list, written continuously. |
| `lastgood` | A protected copy, only replaced by a known-good list. |
| `tabs.json.bak-…` | Rolling backups, newest first. |
| `scrollback` | Last resort: the directories found inside saved scrollback. |

## 5. Nothing recovered

Everything lives in the state directory — check it before assuming the state is
gone:

```bash
ls -la ~/.s0a-local/state
```

You are looking for `tabs.json`, `tabs.json.lastgood`, a row of
`tabs.json.bak-*` files, and `scrollback.json`. If those exist, your fleet is
recoverable and step 4 should have worked.

One thing that legitimately blocks recovery: a **`closedByUser` tombstone** in
`tabs.json`. The server writes it when a session deliberately closes its last
tab, and start-up recovery honours that intent instead of second-guessing you.
If your fleet is down and `tabs.json` holds a single tab, check for that flag
before concluding the state is lost.

To restore from a specific backup by hand:

```bash
cd ~/.s0a-local/state
cp tabs.json tabs.json.before-manual-restore     # keep an escape hatch
cp tabs.json.bak-2026-09-07-2110 tabs.json       # pick the one you want
launchctl kickstart -k gui/$(id -u)/app.s0a.web.local
```

## 6. Read the logs

```bash
tail -50 ~/.s0a-local/logs/err.log
tail -50 ~/.s0a-local/logs/out.log
```

`err.log` is where a crash on start-up will say why — a port already in use, a
bad config file, a missing dependency after an update.

To see whether the server is running at all and which code it is running:

```bash
ps -axo pid=,command= | grep '[s]erver/src/index.js'
```

The path in that output is the checkout actually being served, which is worth
knowing before you edit anything expecting it to take effect.

---

## Things that are safe, and things that are not

**Safe, any time:**

- Reloading the dashboard. Terminals are server-side; the page is only a view.
- `POST /api/fleet/restore`. It only opens tabs.
- Restarting the server with `launchctl kickstart`. Tabs and the tunnel
  re-adopt.

**Not safe:**

- Deleting anything in `~/.s0a-local/state`. That is the fleet.
- Restarting the server from inside a SoA tab. Use the macOS Terminal app.
- Restoring an old Time Machine snapshot to fix a *display* problem. Restore
  replays saved scrollback into open tabs, which can re-arm terminal modes that
  were captured in it.

## Quick reference

```bash
# is it up?
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4010/

# restart it
launchctl kickstart -k gui/$(id -u)/app.s0a.web.local

# bring the tabs back
curl -sX POST http://127.0.0.1:4010/api/fleet/restore \
     -H 'content-type: application/json' -d '{}'

# what does it say?
tail -50 ~/.s0a-local/logs/err.log
```

Paths and the port above are this install's defaults: port `4010`, launchd label
`app.s0a.web.local`, state in `~/.s0a-local/state`. If yours differ, the
dashboard's own recovery panel fills in the right values for you — it builds
each command from the address you are actually connected to.
