# Self-healing for the prod daemon

Keeps the prod SoA-Web daemon (`com.soa-web.server`, `:7332`, state in `~/.soa-web`)
alive so you never have to manually "restore" it. Two layers:

## 1. `com.soa-web.server.plist` — unconditional KeepAlive

The daemon's launchd job. The key change from the old install is:

```xml
<key>KeepAlive</key><true/>
```

Previously this was a conditional `{ SuccessfulExit: false, Crashed: true }`,
which meant a **clean exit (code 0)** left the daemon dead until someone restored
it — the recurring "context lost, please restore" pain. With `<true/>`, launchd
restarts the daemon on *any* exit within `ThrottleInterval` (10s), and on boot the
daemon re-adopts the Cloudflare tunnel (`tunnel.json`) and the persisted tabs come
back on the next client connect.

## 2. `com.soa-web.watchdog.plist` — health watchdog (`scripts/soa-watchdog`)

launchd KeepAlive only reacts to the process **exiting**. It can't see a **hung**
daemon (process alive, not serving). The watchdog runs every 60s, probes
`http://127.0.0.1:7332/api/ping`, and recovers the daemon if it's unreachable. It
only ever touches `com.soa-web.server` / `:7332`; it never touches the product
instance (`:4010` / `~/.soa-web-local`) and never spawns a second daemon.

Two properties matter on a busy host (this box routinely runs ~18 Claude agents,
load can hit ~100 on 10 cores):

- **Load-tolerant.** If the daemon *process* is alive but a probe fails, it may
  just be CPU-starved — killing it would needlessly churn the tunnel URL. So the
  watchdog re-probes over a ~30s window and only acts if the process is gone or
  stays unresponsive the whole window. A genuinely-dead process is restarted
  immediately (no grace).
- **Tunnel-preserving.** A hung daemon is recovered with **SIGTERM first** so the
  detached `cloudflared` survives and the restart re-adopts the **same** public
  URL (no re-pin). It escalates to `kickstart -k` only if SIGTERM is ignored.

## Install

Copy `scripts/soa-watchdog` to `~/.soa-web/scripts/` (chmod +x), edit the absolute
paths in both plists to the install user's home, then:

```sh
cp deploy/launchd/com.soa-web.server.plist   ~/Library/LaunchAgents/
cp deploy/launchd/com.soa-web.watchdog.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.soa-web.watchdog.plist
# The daemon KeepAlive change applies on the next reload/reboot. To apply now
# (restarts the daemon — drops live PTYs briefly, then tabs/tunnel restore):
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.soa-web.server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.soa-web.server.plist
```

## Stop the daemon intentionally

Because the watchdog revives the daemon, bootout the **watchdog first**:

```sh
launchctl bootout gui/$(id -u)/com.soa-web.watchdog
launchctl bootout gui/$(id -u)/com.soa-web.server
```

Logs: `~/.soa-web/logs/watchdog.log` (only written when it takes action).
