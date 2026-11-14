#!/bin/bash
# One-shot: restore a list of closed tabs (reopen + claude --resume).
# Staggered so we don't cold-start many Claude agents at once. The list is
# local and untracked: one "cwd<TAB>title" per line in $SOA_RESTORE_LIST
# (default ~/.soa-web-local/restore-fleet.tsv; blank lines and # comments skipped).
set -u
LOG="$(dirname "$0")/../logs/restore.log"
STAGGER="${STAGGER:-6}"
LIST="${SOA_RESTORE_LIST:-${SOA_WEB_STATE_DIR:-$HOME/.soa-web-local}/restore-fleet.tsv}"

[ -r "$LIST" ] || { echo "soa-restore-fleet: no restore list at $LIST (cwd<TAB>title per line)" >&2; exit 1; }
RESTORE=$(grep -v '^[[:space:]]*#' "$LIST")

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
