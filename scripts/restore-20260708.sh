#!/bin/bash
# One-shot restore of the fleet lost in the 2026-07-08 17:09 restart.
# Source of truth: ~/.soa-web-local/prerestart-20260708-170809/tabs.json (26 tabs).
# Skips: "Master Chef" (tab #1 revived), "manager" (tab #2, me).
# soa-mobile + manager-ui (cwd ~/.soa-web) spawn WITHOUT resume so they can't
# steal the manager's conversation via `claude --continue` in the shared cwd.
set -u
LOG="$HOME/.soa-web/logs/restore-20260708.log"
STAGGER="${STAGGER:-6}"

# cwd<TAB>title<TAB>mode   (mode: resume | noclaude)
RESTORE=$(cat <<'EOF'
/Users/test/Desktop/Hireal/soa-web	soa-web	resume
/Users/test/Desktop/Side-Proj/Personal-Site	Personal-Site	resume
/Users/test/Desktop/Side-Proj/RealJobPro	RealJobPro	resume
/Users/test/Desktop/Side-Proj/MacnCheese	MacnCheese	resume
/Users/test/Desktop/Side-Proj/socialrizz	socialrizz	resume
/Users/test/Desktop/Summer-2026/ENGR145	ENGR145	resume
/Users/test/Desktop/Summer-2026	Summer-2026	resume
/Users/test/Desktop/Side-Proj/PayAuthDeploy	PayAuthDeploy	resume
/Users/test/Desktop/Side-Proj/sidequestmaxxing	sidequestmaxxing	resume
/Users/test/Desktop/HiOS/HiOS	HiOS	resume
/Users/test/Desktop/Milton	MCPmaxxing	resume
/Users/test/Desktop/Side-Proj/mom-car-sell	mom-car-sell	resume
/Users/test/Desktop/Side-Proj/catfishcam	catfishcam	resume
/Users/test/Desktop/Milton/auradot-site	auradot-site	resume
/Users/test/Desktop/Yifu/STTR-SBIR	STTR-SBIR	resume
/Users/test/Desktop/Side-Proj/cutshort	cutshort	resume
/Users/test/Desktop/Side-Proj/Games	Games	resume
/Users/test/Desktop/Side-Proj/macmirror	macmirror	resume
/Users/test/Desktop/HiOS/hios-website	hios-website	resume
/Users/test/Desktop/Side-Proj/counterpoint	counterpoint	resume
/Users/test/Desktop/Side-Proj/vmaxxing	vmaxxing	resume
/Users/test/Desktop/Side-Proj/ask-gstack	ask-gstack	resume
/Users/test/.soa-web	soa-mobile	noclaude
/Users/test/.soa-web	manager-ui	noclaude
EOF
)

echo "[$(date '+%H:%M:%S')] restore-20260708 starting (stagger=${STAGGER}s)" >>"$LOG"
n=0
while IFS=$'\t' read -r cwd title mode; do
  [ -z "$cwd" ] && continue
  n=$((n+1))
  if [ ! -d "$cwd" ]; then
    echo "[$(date '+%H:%M:%S')] SKIP #$n $title — cwd missing: $cwd" >>"$LOG"
    continue
  fi
  if [ "$mode" = "noclaude" ]; then
    out=$(soa-sessions spawn "$cwd" --title "$title" --no-claude 2>&1)
  else
    out=$(soa-sessions spawn "$cwd" --title "$title" 2>&1)
  fi
  echo "[$(date '+%H:%M:%S')] spawn #$n $title ($mode) -> $out" >>"$LOG"
  sleep "$STAGGER"
done <<< "$RESTORE"
echo "[$(date '+%H:%M:%S')] restore complete ($n processed)" >>"$LOG"
