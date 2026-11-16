# shellcheck shell=bash
# svc.sh — start/restart a SoA supervision job on either init system.
#
# macOS runs every job under launchd (gui/<uid>/<label>); Linux runs the same
# jobs as systemd USER units named after the same label
# (deploy/systemd/install.sh), so a label means the same thing on both:
#   app.s0a.web.local  →  launchd gui/501/app.s0a.web.local
#                      →  systemctl --user … app.s0a.web.local.service
#
#   svc_loaded  <label>      exit 0 if the job is installed/loaded
#   svc_load    <label>      load an installed-but-unloaded job (launchd bootstrap)
#   svc_kick    <label>      start it if it is not running
#   svc_restart <label>      kill and restart it (launchd kickstart -k)

_svc_os="$(uname -s)"

svc_loaded() {
    if [ "$_svc_os" = Darwin ]; then
        launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1
    else
        systemctl --user cat "$1.service" >/dev/null 2>&1
    fi
}

svc_load() {
    if [ "$_svc_os" = Darwin ]; then
        launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$1.plist"
    else
        systemctl --user daemon-reload && systemctl --user enable --now "$1.service"
    fi
}

svc_kick() {
    if [ "$_svc_os" = Darwin ]; then
        launchctl kickstart "gui/$(id -u)/$1"
    else
        systemctl --user start "$1.service"
    fi
}

svc_restart() {
    if [ "$_svc_os" = Darwin ]; then
        launchctl kickstart -k "gui/$(id -u)/$1"
    else
        systemctl --user restart "$1.service"
    fi
}
