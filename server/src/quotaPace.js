// Account-wide range estimates from official percentages, never token totals.
// Kept in the quota service so every paired screen shares the same observations.
const MINUTE = 60000;
const HORIZON = 10 * MINUTE;
const MIN_SPAN = 2 * MINUTE;
const MAX_AGE = 5 * MINUTE;

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
        if (!valid || now - at > MAX_AGE) {
            this.history.delete(id);
            return { state: valid ? 'stale' : 'unavailable' };
        }
        // A reset, corrected percentage, changed source or gap starts a new
        // observation period. No slope ever crosses those boundaries.
        const identity = JSON.stringify([w.windowMinutes, w.resetsAt, w.source || report.source]);
        let history = this.history.get(id);
        let last = history?.samples.at(-1);
        if (last && at < last.at) return { state: 'unavailable' };
        if (history?.identity !== identity || !last || pct < last.used || at - last.at > MAX_AGE ||
            (at === last.at && pct !== last.used)) {
            history = { identity, samples: [] }; this.history.set(id, history); last = null;
        }
        if (!last || at > last.at) history.samples.push({ at, used: pct });
        history.samples = history.samples.filter(p => p.at >= now - HORIZON);
        const first = history.samples[0];
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

module.exports = { QuotaPace };
