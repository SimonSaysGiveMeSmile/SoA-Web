#!/bin/bash
# Recover the fleet from an API/rate-limit stall: nudge each idle-but-alive
# Claude agent to continue its work, in BATCHES OF 5 with a pause between
# batches so we don't re-trip the rate limiter. Excludes the manager's own tab
# and the scratch shells.
set -u
LOG="$(dirname "$0")/../logs/resume-batch.log"
NUDGE="${NUDGE:-continue}"
BATCH="${BATCH:-5}"
GAP="${GAP:-60}"          # seconds between batches

# Project agents to resume (alive in REPL, ctx loaded). NOT #31 (manager/self),
# NOT #27/#28 (scratch shells).
IDS=(23 24 25 26 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49)

echo "[$(date '+%H:%M:%S')] batched resume start: ${#IDS[@]} agents, batch=${BATCH}, gap=${GAP}s, nudge='${NUDGE}'" >>"$LOG"
i=0
batch_n=0
while [ $i -lt ${#IDS[@]} ]; do
  batch_n=$((batch_n+1))
  slice=("${IDS[@]:$i:$BATCH}")
  echo "[$(date '+%H:%M:%S')] --- batch #${batch_n}: ${slice[*]} ---" >>"$LOG"
  for id in "${slice[@]}"; do
    out=$(soa-sessions send "$id" "$NUDGE" 2>&1)
    echo "[$(date '+%H:%M:%S')]   nudge #$id -> $out" >>"$LOG"
  done
  i=$((i+BATCH))
  # Pause before the next batch (skip after the final batch).
  if [ $i -lt ${#IDS[@]} ]; then
    echo "[$(date '+%H:%M:%S')] batch #${batch_n} sent; sleeping ${GAP}s before next batch" >>"$LOG"
    sleep "$GAP"
  fi
done
echo "[$(date '+%H:%M:%S')] batched resume complete ($batch_n batches, ${#IDS[@]} agents)" >>"$LOG"
