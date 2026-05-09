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
# Scope: user-level only. This script does NOT use sudo. Everything
# lives under ~/.soa-web and ~/Library/LaunchAgents (macOS) or
# ~/.config/systemd/user (Linux). Uninstall with:
#     ~/.soa-web/uninstall.sh
#
# Pipe usage (from the deployed site):
#     curl -fsSL https://www.s0a.app/install.sh | sh
#
# Re-running is safe — it stops the existing service, refreshes the
# code, and starts again.

set -eu

REPO_URL="${SOA_WEB_REPO:-https://github.com/SimonSaysGiveMeSmile/SoA-Web.git}"
BRANCH="${SOA_WEB_BRANCH:-main}"
PORT="${SOA_WEB_PORT:-4010}"
INSTALL_DIR="${SOA_WEB_DIR:-$HOME/.soa-web}"
SERVICE_LABEL="app.s0a.web.local"

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

log "SoA-Web local installer  (platform: $PLATFORM, port: $PORT)"

need git
need node
need npm

# Clone or update.
if [ -d "$INSTALL_DIR/.git" ]; then
    log "refreshing $INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
else
    log "cloning $REPO_URL into $INSTALL_DIR"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

log "installing dependencies (this is the slow part)"
# --no-audit/--no-fund reduce noise. node-pty will try to download a
# prebuilt binary; if it fails the user likely needs Xcode CLI tools
# (macOS) or build-essential + python3 (Linux). We leave the error
# visible so the user can act on it rather than masking it.
npm install --no-audit --no-fund --loglevel=error

# Write the uninstall script up front, so even if the next step errors
# the user has a way out.
cat >"$INSTALL_DIR/uninstall.sh" <<UNINST
#!/bin/sh
set -eu
PLATFORM="$PLATFORM"
INSTALL_DIR="$INSTALL_DIR"
LABEL="$SERVICE_LABEL"
if [ "\$PLATFORM" = "darwin" ]; then
    launchctl unload "\$HOME/Library/LaunchAgents/\$LABEL.plist" 2>/dev/null || true
    rm -f "\$HOME/Library/LaunchAgents/\$LABEL.plist"
else
    systemctl --user stop soa-web-local.service 2>/dev/null || true
    systemctl --user disable soa-web-local.service 2>/dev/null || true
    rm -f "\$HOME/.config/systemd/user/soa-web-local.service"
    systemctl --user daemon-reload 2>/dev/null || true
fi
rm -rf "\$INSTALL_DIR"
echo "uninstalled."
UNINST
chmod +x "$INSTALL_DIR/uninstall.sh"

NODE_BIN=$(command -v node)

if [ "$PLATFORM" = "darwin" ]; then
    PLIST_DIR="$HOME/Library/LaunchAgents"
    PLIST="$PLIST_DIR/$SERVICE_LABEL.plist"
    mkdir -p "$PLIST_DIR" "$INSTALL_DIR/logs"
    log "writing launchd agent: $PLIST"
    # macOS launchd plist. KeepAlive=true → auto-restart on crash. The
    # service runs only while the user is logged in (it's a user agent,
    # not a daemon), which is the right scope for a dev tool.
    cat >"$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
    <key>Label</key><string>$SERVICE_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$INSTALL_DIR/server/src/index.js</string>
    </array>
    <key>WorkingDirectory</key><string>$INSTALL_DIR</string>
    <key>EnvironmentVariables</key><dict>
        <key>SOA_WEB_PORT</key><string>$PORT</string>
        <key>SOA_WEB_HOST</key><string>127.0.0.1</string>
        <key>SOA_WEB_AUTOPAIR</key><string>0</string>
        <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$INSTALL_DIR/logs/out.log</string>
    <key>StandardErrorPath</key><string>$INSTALL_DIR/logs/err.log</string>
</dict></plist>
PLIST_EOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
else
    # Linux: systemd user unit. Requires systemd with user bus (most
    # modern distros). Fallback advice printed if systemctl --user fails.
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
WorkingDirectory=$INSTALL_DIR
Environment=SOA_WEB_PORT=$PORT
Environment=SOA_WEB_HOST=127.0.0.1
Environment=SOA_WEB_AUTOPAIR=0
ExecStart=$NODE_BIN $INSTALL_DIR/server/src/index.js
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
UNIT_EOF
    if ! systemctl --user daemon-reload 2>/dev/null; then
        warn "systemctl --user unavailable — start manually with: cd $INSTALL_DIR && npm run local"
    else
        systemctl --user enable --now soa-web-local.service
    fi
fi

# Give the service a moment, then probe to confirm it's up.
sleep 1
if command -v curl >/dev/null 2>&1 && curl -fs "http://127.0.0.1:$PORT/api/ping" >/dev/null 2>&1; then
    log "service is up"
else
    warn "service didn't answer /api/ping yet — it may still be starting. Check logs in $INSTALL_DIR/logs"
fi

printf '\n\033[32m✓ installed\033[0m  \033[2m(in %s)\033[0m\n' "$INSTALL_DIR"
printf '  Shell:     \033[36mhttp://127.0.0.1:%s\033[0m\n' "$PORT"
printf '  Via site:  \033[36mhttps://www.s0a.app\033[0m  \033[2m(auto-detects localhost)\033[0m\n'
printf '  Uninstall: \033[36m%s/uninstall.sh\033[0m\n\n' "$INSTALL_DIR"
