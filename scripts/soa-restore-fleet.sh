#!/bin/bash
# One-shot: restore the 18 tabs the manager closed (reopen + claude --resume).
# Staggered so we don't cold-start 18 Claude agents at once. Skips agents that
# are already alive (RealJobPro, auradot-work, macmirror, anton) and the manager.
set -u
LOG="$(dirname "$0")/../logs/restore.log"
STAGGER="${STAGGER:-6}"

# cwd<TAB>title for the 18 closed tabs (from tabs.json, minus alive + manager).
RESTORE=$(cat <<'EOF'
/Users/test/Desktop/Hireal/soa-web	soa-web
/Users/test/Desktop/Side-Proj/MacnCheese	MacnCheese
/Users/test/Desktop/Side-Proj/socialrizz	socialrizz
/Users/test/Desktop/Side-Proj/PayAuthDeploy	PayAuthDeploy
/Users/test/Desktop/Side-Proj	Side-Proj
/Users/test/Desktop/Milton/ESP32-Knob	ESP32-Knob
/Users/test/Desktop/Side-Proj/Personal-Site	Personal-Site
/Users/test/Desktop/HiOS/HiOS	HiOS
/Users/test/Desktop/Milton	MCPmaxxing
/Users/test/Desktop/Side-Proj/mom-car-sell	mom-car-sell
/Users/test/Desktop/Side-Proj/catfishcam	catfishcam
/Users/test/Desktop/Summer-2026	Summer-2026
/Users/test/Desktop/Milton/auradot-site	auradot-site
/Users/test/Desktop/Yifu/STTR-SBIR	STTR-SBIR
/Users/test/Desktop/Side-Proj/cutshort	cutshort
/Users/test/Desktop/housing-S26	housing-S26
/Users/test/Desktop/Side-Proj/Games	Games
/Users/test/Desktop/Side-Proj/sidequestmaxxing	sidequestmaxxing
EOF
)

echo "[$(date '+%H:%M:%S')] restore starting ($(echo "$RESTORE" | wc -l | tr -d ' ') tabs, stagger=${STAGGER}s)" >>"$LOG"
n=0
while IFS=$'\t' read -r cwd title; do
  [ -z "$cwd" ] && continue
  n=$((n+1))
  if [ ! -d "$cwd" ]; then
    echo "[$(date '+%H:%M:%S')] SKIP #$n $title — cwd missing: $cwd" >>"$LOG"
    continue
  fi
  out=$(soa-sessions spawn "$cwd" --title "$title" 2>&1)
  echo "[$(date '+%H:%M:%S')] spawn #$n $title -> $out" >>"$LOG"
  sleep "$STAGGER"
done <<< "$RESTORE"
echo "[$(date '+%H:%M:%S')] restore complete ($n processed)" >>"$LOG"
