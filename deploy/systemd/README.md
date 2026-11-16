# SoA-Web on Linux (systemd)

The Linux counterpart of `deploy/launchd/`. Tested on Ubuntu 24.04 (arm64 and
x86_64). Each job becomes a systemd **user** unit with the same name as its
launchd label, so the scripts and the daemon address a job the same way on both
systems (`scripts/lib/svc.sh`).

## Install

```sh
git clone https://github.com/SimonSaysGiveMeSmile/SoA-Web ~/.soa-web
cd ~/.soa-web
deploy/systemd/install.sh --deps   # apt packages + Node 22 (sudo)
npm ci                             # compiles node-pty; there is no Linux prebuild
deploy/systemd/install.sh          # writes + enables the units, turns on lingering
curl -s http://127.0.0.1:4010/api/ping
```

Settings live in `~/.config/soa-web/env` (mode 600); login shells load the
same file through `~/.config/soa-web/shell.sh`, so the `soa-*` CLIs reach the
right daemon. The state dir is mode 700 and every unit runs with `UMask=0077`.

## Private by default

A Linux install opens **no public door**. The daemon binds to loopback and
`SOA_CHANNELS_PUBLIC=0` is set in the env file, which:

- stops the `soa-channels` healer from opening cloudflare, ngrok or a named
  tunnel (it only tries the LAN door) and refuses `soa-channels force cloudflare|ngrok`;
- makes the daemon refuse `/api/pair/start` and close, instead of re-adopt, a
  tunnel left over from before the switch;
- turns off the watchdog's tunnel healing.

Reach the box over Tailscale, or forward the port:
`ssh -L 4010:127.0.0.1:4010 <box>` and open http://127.0.0.1:4010.
To allow a public tunnel, set `SOA_CHANNELS_PUBLIC=1`, set a pairing password
first, then `systemctl --user restart app.s0a.web.local`.

The fleet manager (`soa-sessions`, `com.soa-web.fleet-loop`) needs the Fleet
Manager entitlement, as on macOS: `soa-license issue --to "<you>" --install`.
Without it fleet-loop restarts every few seconds and does nothing.

Lingering (`loginctl enable-linger`) is what makes the units start at boot
and keep running after you log out. The installer turns it on.

## What runs

| Unit | Replaces | Kind |
| --- | --- | --- |
| `app.s0a.web.local` | the daemon | service, `Restart=always` |
| `com.soa-web.fleet-loop` | fleet event loop | service, `Restart=always` |
| `com.soa-web.watchdog-4010` | hung/down daemon recovery | timer, 60 s |
| `com.soa-web.channels` | tunnel healer | timer, 60 s |
| `com.soa-web.manager-watchdog-4010` | manager tab | timer, 90 s |
| `com.soa-web.usage-alert` | usage push alerts | timer, 120 s |
| `com.soa-web.usage-throttle` | usage throttle | timer, 180 s |
| `com.soa-web.heartbeat` | fleet digest | timer, 600 s |
| `com.soa-web.nudge-stale-4010` | fleet-continue | timer, 900 s |

Only the daemon unit uses `KillMode=process`: a restart signals the daemon
alone, so a tunnel it detached survives and is re-adopted with the same public
URL (what `AbandonProcessGroup` does under launchd). The daemon kills its own
headless browsers on shutdown. Every other unit is stopped as a whole.

Not installed by default: `selfupdate`, `autocommit`, `mcp`, `doors`. Add them
to the `JOBS` table in `install.sh` once the box is proven. If the same repos
are checked out on another machine, run `autocommit` and `selfupdate` on only
one of them.

macOS-only, with no Linux equivalent: desktop remote and screen streaming, the
Swift helpers (`*.swift`), `soa-health` (thermal/battery), and `soa-permissions`.
The daemon already reports those as unavailable on Linux instead of failing.

## Day to day

```sh
systemctl --user status app.s0a.web.local
systemctl --user restart app.s0a.web.local      # graceful: flushes tabs, keeps the tunnel
systemctl --user list-timers 'com.soa-web*'
tail -f ~/.soa-web-local/logs/channels.out.log
deploy/systemd/install.sh --remove              # stop + delete units; state is kept
```
