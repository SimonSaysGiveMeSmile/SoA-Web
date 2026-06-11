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
same view. As a manager agent: poll `list`, `read` any session that needs
attention, then `send` an answer, `compact` a high-context one, or `soa-msg` the
user when a decision is needed. Keep your own running notes as your context.

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
