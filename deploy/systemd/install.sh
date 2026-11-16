#!/usr/bin/env bash
#
# Install SoA-Web on a headless Linux box as systemd USER units — the Linux
# counterpart of deploy/launchd/. Each unit is named after the launchd label it
# replaces, so scripts/lib/svc.sh, the watchdog and /api/daemon/restart address
# a job by the same name on both systems.
#
#   deploy/systemd/install.sh --deps   # once, as a sudo-capable user: apt packages + Node 22
#   deploy/systemd/install.sh          # write + enable the units (no sudo except linger)
#   deploy/systemd/install.sh --remove # stop + delete the units (state dir untouched)
#
# Layout it assumes (same as macOS): code in ~/.soa-web, state in ~/.soa-web-local.
# Settings live in ~/.config/soa-web/env (created once, mode 600; edit and
# `systemctl --user restart app.s0a.web.local`).
#
# Not installed here (macOS-only): desktop-remote, health, the Swift helpers.
# Not installed by default: selfupdate, autocommit, mcp, doors — enable by hand
# once the box is proven (see deploy/systemd/README.md).

set -euo pipefail

SOA_HOME="${SOA_HOME:-$HOME/.soa-web}"
STATE="${SOA_WEB_STATE_DIR:-$HOME/.soa-web-local}"
UNIT_DIR="$HOME/.config/systemd/user"
ENV_FILE="$HOME/.config/soa-web/env"
NODE="$(command -v node || true)"

die() { echo "install: $*" >&2; exit 1; }

if [ "${1:-}" = "--deps" ]; then
    command -v apt-get >/dev/null || die "--deps supports Debian/Ubuntu (apt) only"
    # Retries + a read timeout: a stalled mirror otherwise hangs the install forever.
    apt=(sudo apt-get -o Acquire::Retries=8 -o Acquire::http::Timeout=20)
    "${apt[@]}" update
    # build-essential + python3: node-pty ships no Linux prebuild and compiles on npm ci.
    # lsof: codex thread matching. jq/curl/git: the supervision scripts.
    "${apt[@]}" install -y --no-install-recommends build-essential python3 git curl jq lsof ca-certificates
    if ! node -v 2>/dev/null | grep -q '^v2[2-9]'; then
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        "${apt[@]}" install -y nodejs
    fi
    echo "deps ok: $(node -v)"
    exit 0
fi

# label | kind (service|timer:<seconds>) | command (relative to $SOA_HOME) | extra Environment= lines (;-separated)
JOBS=(
  "app.s0a.web.local|service|node server/src/index.js|"
  "com.soa-web.watchdog-4010|timer:60|bash scripts/soa-watchdog|SOA_WEB_LABEL=app.s0a.web.local;SOA_WEB_MANAGE_TUNNEL=0"
  "com.soa-web.channels|timer:60|bash scripts/soa-channels|"
  "com.soa-web.fleet-loop|service|bash scripts/soa-fleet-loop|SOA_FLEETLOOP_COMPACT=0"
  "com.soa-web.manager-watchdog-4010|timer:90|bash scripts/soa-manager-watchdog|"
  "com.soa-web.heartbeat|timer:600|bash scripts/soa-heartbeat|"
  "com.soa-web.nudge-stale-4010|timer:900|bash scripts/soa-nudge-stale|"
  "com.soa-web.usage-alert|timer:120|node scripts/soa-usage-alert|"
  "com.soa-web.usage-throttle|timer:180|node scripts/soa-usage-throttle|"
)

if [ "${1:-}" = "--remove" ]; then
    for job in "${JOBS[@]}"; do
        IFS='|' read -r label kind _ _ <<<"$job"
        unit="$label.service"; [ "${kind%%:*}" = timer ] && unit="$label.timer"
        systemctl --user disable --now "$unit" 2>/dev/null || true
        rm -f "$UNIT_DIR/$label.service" "$UNIT_DIR/$label.timer"
    done
    systemctl --user daemon-reload
    echo "removed. State in $STATE was left alone."
    exit 0
fi

[ -n "$NODE" ] || die "node not found — run: $0 --deps"
[ -f "$SOA_HOME/server/src/index.js" ] || die "no SoA checkout at $SOA_HOME"
[ -d "$SOA_HOME/node_modules/node-pty" ] || die "run 'npm ci' in $SOA_HOME first"
# Unit files take these paths unquoted; systemd splits on spaces and expands %.
for p in "$HOME" "$SOA_HOME" "$STATE" "$NODE"; do
    case "$p" in *[[:space:]%]*) die "path '$p' contains a space or '%', which systemd units can't take" ;; esac
done

mkdir -p "$UNIT_DIR" "$STATE/logs" "$(dirname "$ENV_FILE")" "$HOME/.local/bin"
# The state dir holds pairing tokens, the license and terminal scrollback.
chmod 700 "$STATE" "$(dirname "$ENV_FILE")"

# systemctl --user needs the user manager. Lingering starts it (and keeps the
# units running after logout and across reboots); a sudo/su shell also lacks
# XDG_RUNTIME_DIR, so point at it explicitly.
me="${USER:-$(id -un)}"
if [ "$(loginctl show-user "$me" -p Linger --value 2>/dev/null)" != yes ]; then
    sudo loginctl enable-linger "$me" || echo "warning: run 'sudo loginctl enable-linger $me' or the units stop when you log out"
fi
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
for _ in 1 2 3 4 5; do [ -S "$XDG_RUNTIME_DIR/bus" ] && break; sleep 1; done
[ -S "$XDG_RUNTIME_DIR/bus" ] || die "no systemd user manager for $me (log in over SSH as $me, not via sudo/su, and run this again)"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

if [ ! -f "$ENV_FILE" ]; then
    umask 077
    cat > "$ENV_FILE" <<EOF
# SoA-Web settings for the systemd units. Loopback-only by default: reach it
# through the tunnel (pairing token + password) or an SSH/Tailscale forward.
SOA_WEB_HOST=127.0.0.1
SOA_WEB_PORT=4010
SOA_WEB_STATE_DIR=$STATE
SOA_WEB_AUTOPAIR=0
SOA_WEB_SECURE_COOKIE=1
SOA_WEB_ALLOWED_ORIGINS=https://www.s0a.app,http://127.0.0.1:4010,http://localhost:4010
# Private by default: no public tunnel. Reach the box over Tailscale or an SSH
# forward (ssh -L 4010:127.0.0.1:4010 <box>). Set to 1 to let the healer open a
# cloudflare/ngrok tunnel, and set a pairing password first if you do.
SOA_CHANNELS_PUBLIC=0
EOF
    umask 022
    echo "wrote $ENV_FILE"
fi

# Interactive shells (and the agents in them) read the same settings as the
# units, so soa-sessions & co. talk to the right port and state dir.
SHELL_ENV="$HOME/.config/soa-web/shell.sh"
{
    echo '# Generated by deploy/systemd/install.sh: the unit settings for login shells.'
    echo "[ -f \"$ENV_FILE\" ] && { set -a; . \"$ENV_FILE\"; set +a; }"
    echo 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac'
} > "$SHELL_ENV"
for rc in "$HOME/.profile" "$HOME/.bashrc"; do
    grep -qs 'soa-web/shell.sh' "$rc" || printf '\n. "%s"\n' "$SHELL_ENV" >> "$rc"
done

# The CLIs (soa-msg, soa-sessions, …) on PATH for interactive shells and agents.
for s in "$SOA_HOME"/scripts/soa-*; do
    case "$s" in *.swift|*.html|*.cjs|*.mjs|*.sh) continue ;; esac
    ln -sf "$s" "$HOME/.local/bin/$(basename "$s")"
done

units=()
unit_path="$HOME/.local/bin:$SOA_HOME/scripts:$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin"

for job in "${JOBS[@]}"; do
    IFS='|' read -r label kind cmd extra <<<"$job"
    prog="${cmd%% *}"; args="${cmd#* }"
    case "$prog" in node) prog="$NODE" ;; bash) prog=/bin/bash ;; esac
    envs="Environment=PATH=$unit_path"
    if [ -n "$extra" ]; then
        IFS=';' read -ra kv <<<"$extra"
        for e in "${kv[@]}"; do envs+=$'\n'"Environment=$e"; done
    fi
    log="$STATE/logs/${label#com.soa-web.}"

    if [ "$kind" = service ]; then
        # Only the daemon keeps its children on stop/restart: it detaches the
        # tunnel on purpose and re-adopts it on boot (same public URL). Every
        # other service (fleet-loop's watch pipeline) is stopped as a whole.
        km=""
        [ "$label" = app.s0a.web.local ] && km="KillMode=process"
        cat > "$UNIT_DIR/$label.service" <<EOF
[Unit]
Description=SoA-Web $label
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$SOA_HOME
EnvironmentFile=-$ENV_FILE
$envs
ExecStart=$prog $SOA_HOME/$args
# Like launchd KeepAlive=true: restart on ANY exit.
Restart=always
RestartSec=10
$km
UMask=0077
StandardOutput=append:$log.out.log
StandardError=append:$log.err.log

[Install]
WantedBy=default.target
EOF
        units+=("$label.service")
    else
        every="${kind#timer:}"
        cat > "$UNIT_DIR/$label.service" <<EOF
[Unit]
Description=SoA-Web $label (one run)

[Service]
Type=oneshot
WorkingDirectory=$SOA_HOME
EnvironmentFile=-$ENV_FILE
$envs
# "-": a non-zero exit (e.g. the healer finding no door this pass) is logged,
# not a failed unit — launchd StartInterval jobs behave the same way.
ExecStart=-$prog $SOA_HOME/$args
# The watchdog may respawn the tunnel; it must outlive this run.
KillMode=process
UMask=0077
StandardOutput=append:$log.out.log
StandardError=append:$log.err.log
EOF
        cat > "$UNIT_DIR/$label.timer" <<EOF
[Unit]
Description=SoA-Web $label every ${every}s

[Timer]
OnBootSec=60
OnUnitInactiveSec=${every}s
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF
        units+=("$label.timer")
    fi
done

systemctl --user daemon-reload
systemctl --user enable --now "${units[@]}"


echo "installed ${#units[@]} units. Check: systemctl --user list-timers 'com.soa-web*'; curl -s http://127.0.0.1:4010/api/ping"
