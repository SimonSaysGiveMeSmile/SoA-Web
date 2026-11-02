# soa-health — system health, temperature and runaway processes

`scripts/soa-health` watches the Mac that runs Son of Anton: CPU, memory, load,
swap and temperature, sampled every minute. When one of **your own** processes
stays heavy it tells you (chat bubble + push, with a one-tap **Stop it** link),
or — only if you deliberately turn it on — stops it automatically. Monitoring
can be switched on and off from the dashboard, the phone or the CLI.

It is a standalone loopback service (`127.0.0.1:6084`), reached by browsers
through the daemon's authed `/preview/6084/` proxy, so it needs **no daemon
restart**, no sudo and no new macOS permission.

## Running it

```bash
nohup node scripts/soa-health serve >/dev/null 2>&1 &     # by hand
cp deploy/launchd/com.soa-web.health.plist ~/Library/LaunchAgents/ &&
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.soa-web.health.plist
```

State: `${SOA_WEB_STATE_DIR:-~/.soa-web-local}/health/` — `settings.json` (0600),
`history.jsonl` (24 h of samples), `actions.jsonl` (audit log), `key` (0600, the
CLI's local key), `soa-thermal` (the compiled helper). Log:
`~/.soa-web-local/logs/health.log`.

## What it samples

| Field | Source |
|---|---|
| total CPU % | `os.cpus()` deltas between samples |
| per-process CPU % | `ps` cumulative CPU time deltas ÷ wall time (100 = one full core) |
| memory used %, pressure | `sysctl kern.memorystatus_level` / `kern.memorystatus_vm_pressure_level` (what `memory_pressure` reports), `vm_stat` |
| swap | `sysctl vm.swapusage` |
| load average | `os.loadavg()` |
| thermal state | `ProcessInfo.thermalState` (nominal / fair / serious / critical) via `scripts/soa-thermal.swift` |
| CPU / max temperature | IOHIDEventSystemClient temperature sensors (Apple Silicon `PMU tdie*` etc.; resolved with `dlsym`, so a macOS without them falls back to thermal state only) |
| battery temperature | `ioreg -rn AppleSmartBattery` `Temperature` |

The helper is compiled with `swiftc` on first use (≈3 s). Without it (no Xcode
CLT, or `SOA_HEALTH_NO_HELPER=1`) thermal state reads `unknown` and the battery
temperature stands in. Every sample records the temperature; the trend is the
delta since the previous sample (°C/min) plus a 10-minute linear slope →
`rising` (> +0.3 °C/min) / `falling` / `steady`.

## When a process becomes a candidate

All of these, together:

1. Over a threshold **for `sustainSamples` consecutive samples** (default 3):
   CPU ≥ `cpuPct` (85 % of one core), or RSS ≥ `rssPctOfRam` (25 % of RAM) —
   or a leak: RSS grew ≥ `leakMB` (1024) over `leakWindowMin` (10) minutes.
   Processes are tracked by **pid + start time**, so a reused pid starts at zero.
   The run is wall time: an extra sample taken less than half an interval after
   the previous one (`POST /sample`, monitor re-enabled) does not advance it, and
   a gap over 2.5 intervals (monitor off, Mac asleep) starts it over. Samples are
   scheduled against the previous due time, so they do not drift.
   A `denylist` entry is flagged on the first sample over a threshold.
2. Owned by the current user (others cannot be signalled anyway).
3. Not protected.

### Protected — never terminated

Hard-coded, cannot be overridden: pid ≤ 1; `launchd`, `kernel_task`,
`WindowServer`, `loginwindow`, `Dock`, `Finder`, `SystemUIServer`,
`ControlCenter`, `coreaudiod`, `ssh-agent`, `gpg-agent`, any `com.apple.*`;
anything under `/System`, `/usr/libexec`, `/usr/sbin`, `/sbin`, `/Library/Apple`.
Names and paths are checked against both `ps` comm (argv[0], which a process
can set to anything or leave bare) and the **real executable path**
(`proc_pidpath`, via `soa-thermal --paths`); auto mode refuses a process whose
executable path cannot be resolved. Also protected: the **SoA daemon and every descendant** (tabs, shells,
Claude/Codex agents and their tools — found from `daemon.lock` and from the
daemon's command line); every `soa-*` service and its children (desktop remote,
dictation, MCP, usage-quota, watchdogs); coding agents in any case (`claude`,
`Claude`, versioned native binaries, `codex-*` helpers, anything under
`~/.claude/` or `~/.codex/`, the Claude/Codex desktop apps) **and everything
they started** — including Bash-tool shells and background jobs that were
re-parented to launchd (`~/.claude/shell-snapshots`, the per-user claude tmp
dir);
tunnels (`cloudflared`, `ngrok`, `ssh`, `sshd`, `autossh`, `mosh-server`,
`tailscaled`, …); `Sarea.app`, `SoA Pointer.app`; terminals and multiplexers
(Terminal, iTerm, Ghostty, WezTerm, Alacritty, kitty, Warp, `tmux`, `screen`);
the health service itself and its parent chain; and the **frontmost app**
(including helpers inside its bundle and every process it started). User-extendable through `allowlist`.

Lists match a process name / app name case-insensitively, or — for entries
starting with `/` — an executable path prefix.

## What happens

- **notify** (default): one chat + push message per process per
  `notify.cooldownMin` (30), e.g. *"yes (pid 812) is using a lot: CPU 97% of one
  core for 3 samples (~3 min). Tap to stop it: <link>"*. The link opens
  `/preview/6084/confirm?c=<id>` (valid 1 h) — a page that shows the process and
  a **Stop it** button. Opening the link never stops anything by itself.
- **auto** (off by default; turning it on needs the explicit confirm phrase):
  at most one termination per sample, max `rate.max` (3) per `rate.windowMin`
  (10 min), and the same command not again within `rate.commandCooldownMin`
  (30 min). Over the limit it falls back to a notification. Auto refuses to act
  when the frontmost app cannot be determined.
- **dryRun**: auto mode decides and audits "would stop …" but sends no signal.
- **Thermal escalation**: thermal state `serious`/`critical` (or CPU ≥
  `tempAlertC`, 95 °C) notifies immediately (again every 15 min while it lasts),
  even with no candidate. In auto mode the top eligible process over `cpuPct`
  is stopped without waiting for the sustain window.

Terminating = re-read the process table and re-verify pid + start time +
command (PID-reuse guard) and every protection rule, then `SIGTERM`, wait 10 s,
`SIGKILL` only if the **same** process is still alive. Every decision (notify,
stop, refusal, dry run, settings change, thermal alert) goes to
`actions.jsonl`, and a stop is announced: *"Stopped yes (pid 812, CPU 97% of one
core for 3 samples). Undo: reopen it."* Manual stops are limited to 10 per 10 min.

## HTTP API

Base URL: `http://127.0.0.1:6084` locally; from a browser / the phone,
`<daemon origin>/preview/6084` (relative URLs work in both because the proxy
injects `<base href="/preview/6084/">` into HTML). All bodies are JSON.

### Auth

Every request: loopback peer + loopback `Host` for this port (the proxy
rewrites Host; a forged Host → **403**). `Sec-Fetch-Site: cross-site` → 403
(and `same-site` on a POST). `GET /health` additionally refuses any
proxy/forwarding header (`X-Forwarded-*`, `Forwarded`, `Via`, `CF-*`,
`X-Real-IP`, `X-Soa-*`, …) → it is direct-loopback only.

Mutating calls (`POST`) carry a JSON body sent as `Content-Type: text/plain`
or `application/json` — **through the `/preview` proxy only `text/plain`
works**, because the daemon's global `express.json()` consumes
`application/json` bodies before proxying them (the request would hang and
end in a 502). Any other content type → 403. They also need either
- `x-health-token: <token>` from `GET /token` (10-minute TTL; also accepted as a
  `token` field in the body) — this is what a UI uses, or
- `Authorization: Bearer <key>` with `<state>/health/key` — only from a direct
  local caller (refused when a forwarding header is present; the proxy strips
  `Authorization` anyway). The CLI uses this.

Missing / bad token → **403** `forbidden`. No CORS headers are ever sent.

### `GET /token`
`{ token, ttl: 600000, header: "x-health-token" }`

### `GET /health` (direct loopback only)
`{ ok, service: "soa-health", version, enabled, mode, lastSampleAt, uptimeSec }`

### `GET /status`
```jsonc
{
  "ok": true, "service": "soa-health", "version": "1.0.0", "pid": 123, "port": 6084, "now": 0,
  "enabled": true,            // monitor switch (settings)
  "monitoring": true,         // a sample timer is armed
  "mode": "notify",           // "notify" | "auto"
  "dryRun": false,
  "autoTerminate": false,     // mode === "auto" && !dryRun
  "testMode": false,
  "intervalSec": 60, "nextSampleAt": 0, "samples": 42, "uptimeSec": 2520,
  "sample": {                 // null until the first sample
    "t": 0, "reason": "timer|boot|manual|enabled", "intervalSec": 60,
    "cpu": { "totalPct": 37.2, "cores": 10, "load": [3.1, 2.8, 2.5] },
    "memory": { "totalMB": 65536, "usedPct": 31, "pressure": "normal|warn|critical|null",
                "compressedMB": 0, "wiredMB": 0, "swapUsedMB": 0, "swapTotalMB": 0 },
    "thermal": { "state": "nominal|fair|serious|critical|unknown", "code": 0, // 0-3 or null
                 "cpuC": 58.4, "maxC": 61.0, "batteryC": 30.7,          // °C or null
                 "source": "hid|thermal-state|battery|none",
                 "sensors": [{ "name": "PMU tdie4", "c": 61.0, "n": 2 }] }, // hottest first, ≤40
    "frontmost": { "pid": 983, "name": "Google Chrome", "bundlePath": "/Applications/Google Chrome.app" },
    "processes": 812
  },
  "trend": { "tempC": 58.4, "deltaPerMin": 0.6, "slope10m": 0.27,
             "direction": "rising|falling|steady|unknown", "min10m": 57.9, "max10m": 58.6 },
  "candidates": [ Proc + { "reasons": [Reason], "sustained": { "cpu": 3, "memory": 0 }, "score": 1.14 } ],
  "watch":      [ Proc + reasons:[] ],   // over a threshold now, not yet sustained, eligible
  "top":        [ Proc ],                // top 12 by CPU, protected ones included
  "topMemory":  [ Proc ],                // top 5 by RSS
  "rate": { "used": 0, "max": 3, "windowMin": 10 },
  "thresholds": { /* settings.thresholds */ },
  "helper": { "built": true, "error": null },
  "lastAction": Action | null, "lastError": null
}
```
`Proc` = `{ pid, ppid, startTime (epoch ms, 1 s resolution), name, app (bundle
name or null), comm (executable path), args (≤200 chars), uid, cpu (% of one
core), rssMB, memPct, protected, protectedReason }`.
`Reason` = `{ kind: "cpu"|"memory"|"leak"|"thermal", value, threshold, samples?,
windowMin?, detail }` (`detail` is the human sentence).

### `GET /history?minutes=N` (1–1440, default 60)
`{ minutes, intervalSec, samples: [{ t, cpu, load1, memUsedPct, pressure, swapMB,
thermal, tempC, maxC, batteryC, top: [{ pid, name, cpu }] }] }` — `tempC` is the
CPU-die average, or the battery temperature when no sensor is readable.

### `GET /settings`
`{ settings, defaults, limits: { intervalSec: [30, 600], autoConfirm: "auto-terminate", cores, totalMemMB } }`

Settings:
```jsonc
{
  "enabled": true, "intervalSec": 60, "mode": "notify", "dryRun": false,
  "thresholds": { "cpuPct": 85, "sustainSamples": 3, "rssPctOfRam": 25,
                  "leakMB": 1024, "leakWindowMin": 10, "tempAlertC": 95 },
  "notify": { "chat": true, "push": true, "cooldownMin": 30, "thermal": true },
  "allowlist": [], "denylist": [],
  "rate": { "max": 3, "windowMin": 10, "commandCooldownMin": 30 },
  "autoEnabledAt": null       // ISO time auto was switched on (read-only)
}
```

### `POST /settings` (token)
A partial object; nested objects merge, values are clamped. Returns
`{ ok: true, settings }`. Switching to `mode: "auto"` requires
`"confirm": "auto-terminate"` in the same body, otherwise **400**
`{ error, needConfirm: "auto-terminate" }`. Examples:
`{"enabled": false}` · `{"mode": "notify"}` ·
`{"mode": "auto", "confirm": "auto-terminate"}` · `{"dryRun": true}` ·
`{"thresholds": {"cpuPct": 150}}` · `{"allowlist": ["Xcode", "/opt/render/"]}`.

### `POST /terminate` (token)
Body `{ pid, startTime, comm? }` — `startTime` from `/status` is required (PID-reuse
guard). Response is the audit entry: **200** with `result: "terminated"` (exited
after SIGTERM), `"killed"` (needed SIGKILL) or `"dry-run"`; **409** with
`result: "refused"|"failed"` and a `reason` (protected, pid reused, gone, …).

### `POST /sample` (token)
Takes a sample now; returns the `/status` payload.

### `GET /actions?limit=N` (1–1000, default 50)
`{ actions: [Action] }`, newest first. `Action` = `{ t, id, action:
"terminate"|"notify"|"thermal"|"settings", result, by: "auto"|"manual"|"remote"|"local",
pid?, startTime?, name?, comm?, args?, reason?, detail?, signal?, dryRun?, link? }`.

### HTML
`GET /` — a minimal control page (status, monitor on/off, notify/auto with a
confirm dialog, per-candidate Stop). `GET /confirm?c=<id>` — the notification's
stop page.

## CLI

```bash
soa-health status [--json]       soa-health on | off
soa-health mode notify           soa-health mode auto --yes
soa-health dry-run on|off        soa-health history [minutes]
soa-health top                   soa-health kill <pid>
soa-health actions [n]           soa-health doctor
```

## Environment

`SOA_HEALTH_PORT` (6084) · `SOA_WEB_STATE_DIR` · `SOA_HEALTH_DIR` ·
`SOA_HEALTH_LOG` · `SOA_HEALTH_PUBLIC_URL` (base for notification links;
default: the tunnel URL in `tunnel.json`, else `http://127.0.0.1:4010`) ·
`SOA_HEALTH_MIN_INTERVAL_S` (30) · `SOA_HEALTH_TERM_GRACE_MS` (10000) ·
`SOA_HEALTH_NO_HELPER=1` · `SOA_HEALTH_NOTIFY_DRY=1` (write notifications to
`health/notify-dry.jsonl` instead of sending).

Test only: `SOA_HEALTH_TEST_ALLOW_PIDS=a,b` restricts every signal to those
pids (on top of all protections), and `SOA_HEALTH_TEST_THERMAL=serious` fakes
the thermal state (honoured only with the allowlist). Tests:
`server/test/soaHealth.test.js`.
