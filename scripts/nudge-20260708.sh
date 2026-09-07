#!/bin/bash
# Post-restore reactivation of ACTIVE tabs only (per fleet-project-taxonomy).
# Resumed-with-context tabs get "continue"; fresh (0-ctx) actives get a /goal
# rebuilt from the taxonomy. Idle/archived tabs are left at rest on purpose.
set -u
LOG="$HOME/.soa-web/logs/nudge-20260708.log"
G="${G:-8}"
log(){ echo "[$(date '+%H:%M:%S')] $*" >>"$LOG"; }

log "nudge start"
# Resumed actives — plain continue.
for id in 5 7 10 9 6 4; do
  out=$(soa-sessions send "$id" "continue — this tab was restored after the 17:09 daemon restart; pick up exactly where you left off" 2>&1)
  log "send #$id -> $out"; sleep "$G"
done
# Fresh actives — re-arm goals from the taxonomy.
out=$(soa-sessions goal 8 "ENGR145 class file-sharing app: re-orient first (git log, project docs, recent state) — then continue toward spin-up + deploy. The user also asked for a mini page for his group on his main Stanford site: check whether that was already built before starting it. Roster/Google-Drive link is still blocked on the user — skip it." 2>&1); log "goal #8 -> $out"; sleep "$G"
out=$(soa-sessions goal 11 "sidequestmaxxing: re-orient (git log, README, PRD) and continue the project's objectives. Low priority — steady progress, no big pivots." 2>&1); log "goal #11 -> $out"; sleep "$G"
out=$(soa-sessions goal 14 "mom-car-sell: the job is selling the car online, nonstop, with real ads. Re-orient (check which ads are live, any buyer replies) and continue: refresh listings, answer inquiries, escalate real offers to the user." 2>&1); log "goal #14 -> $out"; sleep "$G"
out=$(soa-sessions goal 12 "HiOS (Universal Tool Bus for iOS): re-orient (git log, PRD) and continue development. Low priority — keep the ~hourly commit cadence." 2>&1); log "goal #12 -> $out"; sleep "$G"
out=$(soa-sessions goal 22 "counterpoint (voice-first AI debate sparring partner, Next.js 14 / Vercel): re-orient (git log, PRD) and continue development toward a deployable MVP." 2>&1); log "goal #22 -> $out"
log "nudge complete"
