// Account-wide range estimates from official percentages, never token totals.
// Kept in the quota service so every paired screen shares the same observations.
//
// Samples can be frequent (Codex, every ~15 s) or sparse (Claude's official
// endpoint is polled every few minutes and backs off for 10–30 min on a 429).
// So a history survives gaps up to MAX_GAP and spans up to HORIZON. A frequent
// feed (at least FREQUENT readings in the newest RECENT minutes, spanning
// MIN_SPAN) keeps the recent-weighted slope it always had; a sparse one reads
// from the oldest kept sample, since the official percentages are whole numbers
// and a one-point tick between two polls minutes apart is rounding, not a rate.
// A reading older than MAX_AGE is reported 'stale' but its history is KEPT, so
// the next poll after a backoff continues it instead of warming up again.
const MINUTE = 60000;
const RECENT = 10 * MINUTE;
const HORIZON = 60 * MINUTE;
const MIN_SPAN = 2 * MINUTE;
const MAX_AGE = 5 * MINUTE;
const MAX_GAP = 45 * MINUTE;
const FREQUENT = 5;
// The official resets_at jitters by milliseconds between polls (seen: +65 ms);
// a change this small is the same window, not a reset.
const RESET_TOLERANCE = MINUTE;

function sameWindow(id, w, source) {
    if (!id || id.windowMinutes !== w.windowMinutes || id.source !== source) return false;
    if (id.resetsAt === null || w.resetsAt === null) return id.resetsAt === w.resetsAt;
    return Math.abs(id.resetsAt - w.resetsAt) < RESET_TOLERANCE;
}

class QuotaPace {
    constructor() { this.history = new Map(); }

    window(provider, key, report, now) {
        const id = `${provider}:${key}`, w = report?.windows?.[key];
        // A retired window (the provider dropped that limit) has no pace.
        if (report?.windowStatus?.[key] === 'retired') { this.history.delete(id); return { state: 'retired' }; }
        const at = w?.updatedAt, pct = w?.usedPercent;
        const valid = report?.available && report.status !== 'unavailable' &&
            Number.isFinite(pct) && pct >= 0 && pct <= 100 &&
            Number.isFinite(w?.windowMinutes) && w.windowMinutes > 0 &&
            Number.isFinite(at) && at > 0 && at <= now + 5000 &&
            (w.resetsAt === null || (Number.isFinite(w.resetsAt) && w.resetsAt > now));
        if (!valid) { this.history.delete(id); return { state: 'unavailable' }; }
        if (now - at > MAX_AGE) return { state: 'stale' };
        // A reset, corrected percentage, changed source or long gap starts a new
        // observation period. No slope ever crosses those boundaries.
        const source = w.source || report.source;
        let history = this.history.get(id);
        let last = history?.samples.at(-1);
        if (last && at < last.at) return { state: 'unavailable' };
        if (!sameWindow(history?.identity, w, source) || !last || pct < last.used || at - last.at > MAX_GAP ||
            (at === last.at && pct !== last.used)) {
            history = { samples: [] }; this.history.set(id, history); last = null;
        }
        history.identity = { windowMinutes: w.windowMinutes, resetsAt: w.resetsAt, source };
        if (!last || at > last.at) history.samples.push({ at, used: pct });
        history.samples = history.samples.filter(p => p.at >= now - HORIZON);
        // Frequent feed: the oldest within RECENT (as before sparse support);
        // otherwise the oldest kept sample.
        const recent = history.samples.filter(p => p.at >= now - RECENT);
        const first = recent.length >= FREQUENT && at - recent[0].at >= MIN_SPAN ? recent[0] : history.samples[0];
        const sampledMs = first ? at - first.at : 0;
        const base = { updatedAt: at, sampledMs, percentPerHour: null, remainingMs: null };
        if (pct === 100) return { ...base, state: 'limited', remainingMs: 0 };
        if (sampledMs < MIN_SPAN) return { ...base, state: 'warming' };
        const delta = pct - first.used;
        if (delta <= 0) return { ...base, state: 'steady' };
        const percentPerHour = delta * 3600000 / sampledMs;
        const remainingMs = (100 - pct) * 3600000 / percentPerHour;
        const resetsFirst = w.resetsAt !== null && remainingMs >= w.resetsAt - now;
        return { ...base, state: resetsFirst ? 'reset-first' : 'estimated', percentPerHour, remainingMs };
    }

    sample(data, now = Date.now()) {
        return Object.fromEntries(['claude', 'codex'].map(provider => [provider, {
            ...data[provider],
            // Weekly is the primary window for every provider (the 5h limit is
            // being retired); session is secondary and may be absent/retired.
            primaryWindow: data[provider]?.primaryWindow || 'weekly',
            pace: Object.fromEntries(['session', 'weekly'].map(key =>
                [key, this.window(provider, key, data[provider], now)])),
        }]));
    }
}

module.exports = { QuotaPace, MAX_GAP, HORIZON, MIN_SPAN, FREQUENT };
