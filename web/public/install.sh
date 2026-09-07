#!/bin/sh
# shellcheck shell=sh
#
# SoA-Web local installer.
#
# One-shot install of a user-level background service that runs the
# SoA-Web backend on 127.0.0.1:4010. After this completes, the deployed
# frontend (www.s0a.app) auto-detects localhost and boots straight into
# server mode — no more copy/paste, no tunnel, no token.
#
# Layout (everything self-contained, nothing shared with other daemons):
#     ~/.s0a-local/app     code (git checkout)
#     ~/.s0a-local/state   daemon state (tabs, scrollback, keys) — wired
#                          via SOA_WEB_STATE_DIR so it can NEVER collide
#                          with a personal deploy living in ~/.soa-web
#     ~/.s0a-local/logs    service logs
#
# Scope: user-level only. This script does NOT use sudo. Services live in
# ~/Library/LaunchAgents (macOS) or ~/.config/systemd/user (Linux).
# Uninstall with:
#     ~/.s0a-local/uninstall.sh
#
# Pipe usage (from the deployed site):
#     curl -fsSL https://www.s0a.app/install.sh | sh
#
# Re-running: if a healthy backend already answers on the target port the
# installer adopts it and exits (stop the service first to force a code
# refresh); otherwise it stops any stale service, refreshes the code, and
# starts again. A legacy install (pre state-isolation) is migrated to the
# new layout automatically; its old files in ~/.soa-web are left in place.
#
# Env knobs: SOA_WEB_DIR (install root), SOA_WEB_PORT, SOA_WEB_BRANCH,
# SOA_WEB_REPO, SOA_WEB_FRONTEND, SOA_WEB_FORCE=1 (reset a dirty/diverged
# checkout anyway — a backup branch + stash are created first).

set -eu

REPO_URL="${SOA_WEB_REPO:-https://github.com/SimonSaysGiveMeSmile/SoA-Web.git}"
BRANCH="${SOA_WEB_BRANCH:-main}"
PORT="${SOA_WEB_PORT:-4010}"
ROOT="${SOA_WEB_DIR:-$HOME/.s0a-local}"
APP_DIR="$ROOT/app"
STATE_DIR="$ROOT/state"
LOG_DIR="$ROOT/logs"
SERVICE_LABEL="app.s0a.web.local"
FORCE="${SOA_WEB_FORCE:-0}"
# Deployed frontend origin. Added to the backend's CORS allowlist so
# visiting the hosted site auto-upgrades into server mode (the frontend
# probes http://127.0.0.1:4010/api/ping on every load).
FRONTEND_ORIGIN="${SOA_WEB_FRONTEND:-https://www.s0a.app}"

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!! \033[0m %s\n' "$*"; }
die() { printf '\033[31mxx \033[0m %s\n' "$*" >&2; exit 1; }

need() {
    command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1 — please install it and retry"
}

platform() {
    case "$(uname -s)" in
        Darwin) echo darwin ;;
        Linux)  echo linux ;;
        *)      echo other ;;
    esac
}

PLATFORM=$(platform)
[ "$PLATFORM" != "other" ] || die "unsupported platform: $(uname -s). Manual install: https://github.com/SimonSaysGiveMeSmile/SoA-Web"

log "SoA-Web local installer  (platform: $PLATFORM, port: $PORT, root: $ROOT)"

need git
need node
need npm
# curl is load-bearing: the post-install verification gate uses it, and
# without it a perfectly healthy install would be reported as FAILED.
need curl

# Mobile bridge needs a public tunnel. cloudflared is preferred — free, fast,
# no account — and the daemon SELF-PROVISIONS it: the server downloads the
# official release into its state dir on first use (tunnelProvision.js), so no
# platform is degraded. With SOA_WEB_AUTOPAIR=1 (set below) the tunnel now
# auto-starts on boot, so a fresh install is ready to pair with zero steps —
# safe because the tunnel is QR-holder-only (only a device with the scanned
# token gets in; see tunnelGate.js). A brew install is still nicer when
# available (keeps it updated), so best-effort it here; NEVER fatal — a missing
# provider only costs a one-time ~20 MB download.
ensure_tunnel_provider() {
    if command -v cloudflared >/dev/null 2>&1 || command -v ngrok >/dev/null 2>&1; then
        return 0
    fi
    if [ "$PLATFORM" = darwin ] && command -v brew >/dev/null 2>&1; then
        log "no tunnel provider found — installing cloudflared via brew (for mobile access)…"
        brew install cloudflared >/dev/null 2>&1 \
            && log "cloudflared installed" \
            || log "cloudflared install skipped — the daemon will auto-download it on first pair"
    else
        log "no cloudflared/ngrok — the daemon will auto-download cloudflared on first pair"
    fi
}
ensure_tunnel_provider

ping_ok() {
    # $1 = port. True only if a healthy *SoA* backend answers there — match
    # the service name, not just {"ok":true}, so we never "adopt" some
    # unrelated local health endpoint squatting on the port.
    RES=$(curl -fs --max-time 3 "http://127.0.0.1:$1/api/ping" 2>/dev/null) || return 1
    case "$RES" in
        *'"name":"soa-web"'*) return 0 ;;
    esac
    return 1
}

stop_service() {
    if [ "$PLATFORM" = "darwin" ]; then
        launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null || true
    else
        systemctl --user stop soa-web-local.service 2>/dev/null || true
    fi
}

# ── Preflight ─────────────────────────────────────────────────────────────
# 0. Legacy install (pre state-isolation): the old installer wrote this
#    same service label with code AND state in ~/.soa-web and no
#    SOA_WEB_STATE_DIR — the state-collision bug this layout exists to fix.
#    Migrate it: stop the old service and fall through to a fresh install
#    in the new layout. The legacy files in ~/.soa-web are NOT touched
#    (they may belong to a personal deploy).
if [ "$PLATFORM" = "darwin" ]; then
    OLD_UNIT_FILE="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
else
    OLD_UNIT_FILE="$HOME/.config/systemd/user/soa-web-local.service"
fi
if [ -f "$OLD_UNIT_FILE" ] && ! grep -q "SOA_WEB_STATE_DIR" "$OLD_UNIT_FILE"; then
    warn "found a legacy $SERVICE_LABEL service (no state isolation) — migrating to the new layout."
    stop_service
fi

# 1. A healthy, isolated SoA backend already on the target port → adopt it.
#    (Covers re-runs while the service is up, and any other SoA daemon the
#    user pointed at this port on purpose.)
if ping_ok "$PORT"; then
    log "a healthy SoA-Web backend already answers on 127.0.0.1:$PORT — adopting it."
    log "nothing to do. Open $FRONTEND_ORIGIN and it will connect."
    log "(to force a code refresh, stop that service first and rerun)"
    exit 0
fi

# 2. Port taken by something that is NOT a SoA backend → name it and stop.
if command -v lsof >/dev/null 2>&1; then
    OWNER=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $1" (pid "$2")"}') || OWNER=""
    if [ -n "$OWNER" ]; then
        die "port $PORT is in use by $OWNER and it does not answer /api/ping as SoA-Web. Stop it, or rerun with SOA_WEB_PORT=<other port>."
    fi
fi

# 3. Our state dir locked by a live daemon that didn't answer the ping →
#    something is wedged; refuse rather than corrupt. (Path passed via
#    argv, not interpolated into the JS, so odd characters can't silently
#    disable this check.)
if [ -f "$STATE_DIR/daemon.lock" ]; then
    LOCK_PID=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.pid||""))}catch(e){}' "$STATE_DIR/daemon.lock" 2>/dev/null) || LOCK_PID=""
    if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
        die "a daemon (pid $LOCK_PID) holds $STATE_DIR/daemon.lock but doesn't answer on port $PORT. Inspect it before reinstalling (logs: $LOG_DIR)."
    fi
fi

# 4. Never claim a directory that isn't ours: if ROOT exists, has content,
#    and lacks our ownership marker, it belongs to something else (e.g.
#    SOA_WEB_DIR pointed at ~/.soa-web or a project dir). The marker is
#    what later licenses uninstall.sh to rm -rf — so it must only ever
#    land in directories this installer owns.
if [ -e "$ROOT" ] && [ ! -f "$ROOT/.s0a-install" ] && [ -n "$(ls -A "$ROOT" 2>/dev/null)" ]; then
    die "$ROOT exists and was not created by this installer — refusing to claim it. Choose an empty/new SOA_WEB_DIR."
fi

mkdir -p "$ROOT" "$STATE_DIR" "$LOG_DIR"
printf 'installed by install.sh — safe for uninstall.sh to remove\n' >"$ROOT/.s0a-install"

# ── Stop any stale service BEFORE touching its code ───────────────────────
# (A wedged daemon that got past the preflight must not keep running while
# git/npm swap files under it.)
stop_service

# ── Clone or update — never destroy local work silently ──────────────────
if [ -d "$APP_DIR/.git" ]; then
    # npm install rewrites package-lock.json (format churn) on every run,
    # which would make every re-install look "dirty". That churn is ours,
    # not the user's — revert it before judging the tree.
    git -C "$APP_DIR" checkout -- package-lock.json 2>/dev/null || true
    DIRTY=$(git -C "$APP_DIR" status --porcelain 2>/dev/null | head -1) || DIRTY=""
    git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
    AHEAD=$(git -C "$APP_DIR" rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null) || AHEAD=0
    if [ -n "$DIRTY" ] || [ "${AHEAD:-0}" -gt 0 ]; then
        if [ "$FORCE" = "1" ]; then
            BACKUP="backup/pre-install-$(date +%Y%m%d-%H%M%S)"
            # Branch preserves local commits; stash preserves the dirty
            # working tree (a branch alone would not — reset --hard still
            # destroys uncommitted edits).
            git -C "$APP_DIR" branch "$BACKUP" 2>/dev/null || true
            git -C "$APP_DIR" stash push --include-untracked -m "$BACKUP" >/dev/null 2>&1 || true
            warn "checkout was dirty/diverged — saved before reset (recover commits: git -C $APP_DIR checkout $BACKUP; recover edits: git -C $APP_DIR stash pop)"
            log "refreshing $APP_DIR (forced)"
            git -C "$APP_DIR" reset --hard "origin/$BRANCH"
        else
            die "$APP_DIR has local changes or commits not on origin/$BRANCH. Refusing to discard them. Rerun with SOA_WEB_FORCE=1 to reset anyway (a backup branch will be created)."
        fi
    else
        log "refreshing $APP_DIR"
        git -C "$APP_DIR" reset --hard "origin/$BRANCH"
    fi
else
    log "cloning $REPO_URL into $APP_DIR"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"

log "installing dependencies (this is the slow part)"
# --no-audit/--no-fund reduce noise. node-pty will try to download a
# prebuilt binary; if it fails the user likely needs Xcode CLI tools
# (macOS) or build-essential + python3 (Linux). We leave the error
# visible so the user can act on it rather than masking it.
npm install --no-audit --no-fund --loglevel=error

# Write the uninstall script up front, so even if the next step errors
# the user has a way out. It removes ONLY this install root — never
# ~/.soa-web or any other daemon's code/state — and checks the ownership
# marker BEFORE it stops or deletes anything.
cat >"$ROOT/uninstall.sh" <<UNINST
#!/bin/sh
set -eu
PLATFORM="$PLATFORM"
ROOT="$ROOT"
LABEL="$SERVICE_LABEL"
# Refuse to delete a directory this installer didn't create — checked
# before any other action so a refusal leaves everything untouched.
[ -f "\$ROOT/.s0a-install" ] || { echo "refusing: \$ROOT was not created by install.sh"; exit 1; }
if [ "\$PLATFORM" = "darwin" ]; then
    launchctl bootout "gui/\$(id -u)/\$LABEL" 2>/dev/null || true
    rm -f "\$HOME/Library/LaunchAgents/\$LABEL.plist"
else
    systemctl --user stop soa-web-local.service 2>/dev/null || true
    systemctl --user disable soa-web-local.service 2>/dev/null || true
    rm -f "\$HOME/.config/systemd/user/soa-web-local.service"
    systemctl --user daemon-reload 2>/dev/null || true
fi
rm -rf "\$ROOT"
echo "uninstalled."
UNINST
chmod +x "$ROOT/uninstall.sh"

NODE_BIN=$(command -v node)

if [ "$PLATFORM" = "darwin" ]; then
    PLIST_DIR="$HOME/Library/LaunchAgents"
    PLIST="$PLIST_DIR/$SERVICE_LABEL.plist"
    mkdir -p "$PLIST_DIR"
    log "writing launchd agent: $PLIST"
    # macOS launchd plist. KeepAlive=true → auto-restart on crash
    # (ThrottleInterval keeps a boot-loop from spinning). The service runs
    # only while the user is logged in (it's a user agent, not a daemon),
    # which is the right scope for a dev tool. SOA_WEB_STATE_DIR pins the
    # daemon's state inside the install root — without it, the server
    # defaults to ~/.soa-web and would clobber a personal deploy's tabs
    # (the June '26 corruption incident). PATH includes /usr/sbin for
    # lsof — tab cwd labeling breaks without it (the df7e365 lesson).
    cat >"$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
    <key>Label</key><string>$SERVICE_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$APP_DIR/server/src/index.js</string>
    </array>
    <key>WorkingDirectory</key><string>$APP_DIR</string>
    <key>EnvironmentVariables</key><dict>
        <key>SOA_WEB_PORT</key><string>$PORT</string>
        <key>SOA_WEB_HOST</key><string>127.0.0.1</string>
        <key>SOA_WEB_STATE_DIR</key><string>$STATE_DIR</string>
        <key>SOA_WEB_AUTOPAIR</key><string>1</string>
        <key>SOA_WEB_BROWSER_DEBUG_PORT</key><string>9333</string>
        <key>SOA_WEB_ALLOWED_ORIGINS</key><string>$FRONTEND_ORIGIN,http://127.0.0.1:$PORT,http://localhost:$PORT</string>
        <key>SOA_WEB_SECURE_COOKIE</key><string>1</string>
        <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>$LOG_DIR/out.log</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/err.log</string>
</dict></plist>
PLIST_EOF
    UID_N=$(id -u)
    # Modern bootstrap sequence. Two traps the legacy unload/load path
    # falls into, observed in the field:
    #   1. a persistent disable override (from an old `launchctl disable`)
    #      makes load fail with the cryptic "Load failed: 5: Input/output
    #      error" — `enable` clears it;
    #   2. launchctl can EXIT 0 on that failure, so `set -eu` sails past
    #      it. We never trust launchctl's exit code; we verify the service
    #      below by asking it to answer /api/ping. Bootstrap stderr is
    #      kept (not discarded) so the failure branch can show it.
    launchctl bootout "gui/$UID_N/$SERVICE_LABEL" 2>/dev/null || true
    launchctl enable "gui/$UID_N/$SERVICE_LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$UID_N" "$PLIST" 2>"$LOG_DIR/bootstrap.err" || true
    launchctl kickstart "gui/$UID_N/$SERVICE_LABEL" 2>>"$LOG_DIR/bootstrap.err" || true
else
    # Linux: systemd user unit. Requires systemd with user bus (most
    # modern distros). Fallback advice printed if systemctl --user fails.
    # Values are quoted systemd-style: unquoted ExecStart/Environment are
    # whitespace-split and break on paths containing spaces.
    UNIT_DIR="$HOME/.config/systemd/user"
    UNIT="$UNIT_DIR/soa-web-local.service"
    mkdir -p "$UNIT_DIR"
    log "writing systemd user unit: $UNIT"
    cat >"$UNIT" <<UNIT_EOF
[Unit]
Description=SoA-Web local terminal backend
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment="SOA_WEB_PORT=$PORT"
Environment="SOA_WEB_HOST=127.0.0.1"
Environment="SOA_WEB_STATE_DIR=$STATE_DIR"
Environment="SOA_WEB_AUTOPAIR=1"
Environment="SOA_WEB_BROWSER_DEBUG_PORT=9333"
Environment="SOA_WEB_ALLOWED_ORIGINS=$FRONTEND_ORIGIN,http://127.0.0.1:$PORT,http://localhost:$PORT"
Environment="SOA_WEB_SECURE_COOKIE=1"
ExecStart="$NODE_BIN" "$APP_DIR/server/src/index.js"
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
UNIT_EOF
    if ! systemctl --user daemon-reload 2>/dev/null; then
        warn "systemctl --user unavailable — start manually with: cd $APP_DIR && npm run local"
    else
        # enable + restart (not `enable --now`): restart applies the new
        # unit definition even if an old process is somehow still active.
        systemctl --user enable soa-web-local.service
        systemctl --user restart soa-web-local.service
    fi
fi

# ── Verify positively: the service must answer, or this install FAILED ───
# (Do not trust service-manager exit codes — see bootstrap comment above.)
UP=0
i=0
while [ $i -lt 20 ]; do
    if ping_ok "$PORT"; then UP=1; break; fi
    sleep 1
    i=$((i + 1))
done

if [ "$UP" != "1" ]; then
    warn "service did not answer http://127.0.0.1:$PORT/api/ping after 20s."
    if [ "$PLATFORM" = "darwin" ]; then
        warn "service state:"
        launchctl print "gui/$(id -u)/$SERVICE_LABEL" 2>&1 | grep -E "state|pid|last exit" | head -5 >&2 || true
        if [ -s "$LOG_DIR/bootstrap.err" ]; then
            warn "bootstrap errors:"
            cat "$LOG_DIR/bootstrap.err" >&2 || true
        fi
    fi
    if [ -s "$LOG_DIR/err.log" ]; then
        warn "last errors ($LOG_DIR/err.log):"
        tail -5 "$LOG_DIR/err.log" >&2 || true
    fi
    warn "stopping the failed service so it doesn't respawn-loop."
    stop_service
    die "install FAILED — the backend is not running. Fix the error above and rerun."
fi

log "service is up"

printf '\n\033[32m✓ installed\033[0m  \033[2m(in %s)\033[0m\n' "$ROOT"
printf '  Shell:     \033[36mhttp://127.0.0.1:%s\033[0m\n' "$PORT"
printf '  Via site:  \033[36m%s\033[0m  \033[2m(auto-detects localhost)\033[0m\n' "$FRONTEND_ORIGIN"
printf '  Phone:     \033[2msidebar → MOBILE LINK → scan the QR (tunnel auto-starts; only the QR holder gets in)\033[0m\n'
printf '  Uninstall: \033[36m%s/uninstall.sh\033[0m\n\n' "$ROOT"
