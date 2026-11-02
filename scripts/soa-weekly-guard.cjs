'use strict';
/**
 * soa-weekly-guard — the shared WEEKLY quota verdict for the usage CLIs and
 * supervisors (soa-sessions usage/throttle/list --cost, soa-usage-alert,
 * soa-usage-throttle).
 *
 * Claude is retiring its 5-hour session limit; the weekly window is the ceiling
 * that actually stops work ("never let the week run out"). This reads the quota
 * service feed (GET /api/usage-quota on loopback, default :4011) and answers:
 *   - is a provider's 5h session window still reported, or retired/not reported?
 *   - where does the weekly % land at its reset at the current pace?
 *   - verdict: THROTTLE (projected >= 100%), WATCH (>= warn) or ok.
 *
 * Contract: data.<provider>.windows.session may be null; windowStatus.session is
 * 'reported' | 'not-reported' | 'retired'. A session window whose resetsAt has
 * passed is stale and never counts as reported. SOA_QUOTA_CLAUDE_SESSION=off
 * forces Claude's 5h window retired; =on keeps it whenever a window is present.
 *
 * Pace: the quota service's own pace (quotaPace.js, a ~10-minute sample) is
 * applied for the next SOA_WEEK_PACE_HOURS (default 5h) and the week-to-date
 * average (used% / elapsed hours, elapsed floored at SOA_WEEK_MIN_AVG_HOURS = 24
 * so the first hours of a week don't extrapolate) for the rest of the window. A 10-minute burst
 * on an integer percentage (Codex) extrapolated over four days reads 3000%;
 * an idle moment would read 0. Without a pace estimate the average is used for
 * the whole remainder. Pure functions + one loopback GET.
 * SOA_QUOTA_FEED_FILE=<json> substitutes a stub feed (tests / dry runs).
 */
const http = require('http');
const fs = require('fs');

const HOUR = 3600000;
const WEEK_MIN = 10080;
const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

function fetchQuota({ port = num(process.env.SOA_QUOTA_PORT, 4011), timeoutMs = 6000 } = {}) {
    if (process.env.SOA_QUOTA_FEED_FILE) {
        try { return Promise.resolve(JSON.parse(fs.readFileSync(process.env.SOA_QUOTA_FEED_FILE, 'utf8'))); }
        catch (_) { return Promise.resolve(null); }
    }
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/usage-quota', method: 'GET', timeout: timeoutMs }, res => {
            let b = ''; res.on('data', d => b += d);
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}

// 'reported' | 'not-reported' | 'retired' for a provider's 5h session window.
function sessionStatus(provider, report, now = Date.now(), env = process.env) {
    const w = report && report.windows && report.windows.session;
    // A reading whose window already reset is never current — not even under =on.
    const current = !!(w && Number.isFinite(w.usedPercent) && !(Number.isFinite(w.resetsAt) && w.resetsAt <= now));
    if (provider === 'claude') {
        const force = String(env.SOA_QUOTA_CLAUDE_SESSION || '').toLowerCase();
        if (force === 'off') return 'retired';
        if (force === 'on' && current) return 'reported';
    }
    if (!report) return 'not-reported';
    const declared = report.windowStatus && report.windowStatus.session;
    if (declared === 'retired') return 'retired';
    if (!current) return 'not-reported';
    if (declared === 'not-reported') return 'not-reported';
    return 'reported';
}

function weeklyProjection(report, now = Date.now(), env = process.env) {
    const paceH = Math.max(0, num(env.SOA_WEEK_PACE_HOURS, 5));
    const w = report && report.windows && report.windows.weekly;
    if (!w || !Number.isFinite(w.usedPercent)) return null;
    const used = w.usedPercent;
    const windowH = num(w.windowMinutes, WEEK_MIN) / 60;
    const resetsAt = Number.isFinite(w.resetsAt) ? w.resetsAt : null;
    if (resetsAt !== null && resetsAt <= now) return null;                  // stale weekly reading
    const hoursLeft = resetsAt === null ? null : Math.max(0, (resetsAt - now) / HOUR);
    const elapsedH = hoursLeft === null ? null : windowH - hoursLeft;
    // Week-to-date average, spread over at least SOA_WEEK_MIN_AVG_HOURS (24h):
    // 6% in the first 2h of a week is a morning's work, not 3%/h for 7 days
    // (that read 504% → THROTTLE at the start of every week).
    const minAvgH = Math.max(1, num(env.SOA_WEEK_MIN_AVG_HOURS, 24));
    const avgRate = elapsedH !== null ? used / Math.max(elapsedH, minAvgH) : null;
    const pace = (report.pace && report.pace.weekly) || {};
    const paceRate = Number.isFinite(pace.percentPerHour) && (pace.state === 'estimated' || pace.state === 'reset-first') ? pace.percentPerHour : null;
    const project = r => (r === null || hoursLeft === null) ? null : used + r * hoursLeft;
    let projected = null, basis = 'none', runOutH = null;
    if (hoursLeft !== null && paceRate !== null) {
        // Current pace for the near term, the week's average after that.
        const near = avgRate === null ? hoursLeft : Math.min(hoursLeft, paceH);
        const tailRate = avgRate === null ? 0 : avgRate;
        const atNear = used + paceRate * near;
        projected = atNear + tailRate * (hoursLeft - near);
        basis = avgRate === null ? 'pace' : 'pace+avg';
        if (paceRate > 0 && atNear >= 100) runOutH = (100 - used) / paceRate;
        else if (tailRate > 0) runOutH = near + (100 - atNear) / tailRate;
    } else if (avgRate !== null) {
        projected = project(avgRate); basis = 'average';
        runOutH = avgRate > 0 ? (100 - used) / avgRate : null;
    }
    if (used >= 100) { projected = Math.max(100, used); runOutH = 0; }
    // Effective %/h over the rest of the window (what the projection implies).
    const rate = projected !== null && hoursLeft ? (projected - used) / hoursLeft : (paceRate !== null ? paceRate : avgRate);
    return {
        used, resetsAt, hoursLeft, rate, basis, projected, paceRate,
        avgRate, avgProjected: project(avgRate),
        runsOutBeforeReset: runOutH !== null && hoursLeft !== null && runOutH < hoursLeft,
        runOutAt: runOutH !== null ? now + runOutH * HOUR : null,
    };
}

function thresholds(budgetsDefault = {}, env = process.env) {
    return {
        projectedPct: num(env.SOA_WEEK_PROJECTED_PCT, num(budgetsDefault.weekProjectedPct, 100)),
        warnPct: num(env.SOA_WEEK_WARN_PCT, num(budgetsDefault.weekWarnPct, 90)),
        usedPct: num(env.SOA_WEEK_USED_PCT, num(budgetsDefault.weekUsedPct, 95)),
    };
}

function verdictFor(proj, th) {
    if (!proj) return 'unknown';
    if (proj.used >= th.usedPct) return 'THROTTLE';
    if (proj.projected !== null && proj.projected >= th.projectedPct) return 'THROTTLE';
    if (proj.projected !== null && proj.projected >= th.warnPct) return 'WATCH';
    return 'ok';
}

// One object per provider: { session, sessionReported, weekly, verdict }.
function assess(feed, { now = Date.now(), budgetsDefault, env = process.env } = {}) {
    const data = (feed && feed.data) || {};
    const th = thresholds(budgetsDefault, env);
    const out = { available: !!(feed && feed.data), thresholds: th };
    for (const p of ['claude', 'codex']) {
        const rep = data[p];
        const session = sessionStatus(p, rep, now, env);
        const weekly = weeklyProjection(rep, now, env);
        out[p] = { session, sessionReported: session === 'reported', weekly, verdict: verdictFor(weekly, th) };
    }
    return out;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtWhen(ms) {
    if (!Number.isFinite(ms)) return '—';
    const d = new Date(ms);
    return `${MON[d.getMonth()]} ${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
const pct = n => n === null || n === undefined || !Number.isFinite(n) ? '—' : Math.round(n) + '%';

// "claude 77% → 171% at reset Nov 3 17:00 (1.0%/h avg) THROTTLE · 5h retired"
function describe(name, a) {
    if (!a || !a.weekly) return `${name} week —${a ? ' · 5h ' + a.session : ''}`;
    const w = a.weekly;
    const rate = w.rate !== null && w.rate !== undefined ? ` (${w.rate.toFixed(1)}%/h ${w.basis === 'average' ? 'avg' : w.basis}${w.paceRate !== null && w.basis !== 'average' ? ', now ' + w.paceRate.toFixed(1) + '%/h' : ''})` : '';
    const five = a.sessionReported ? '' : ` · 5h ${a.session}`;
    return `${name} week ${pct(w.used)} → ${pct(w.projected)} at reset ${fmtWhen(w.resetsAt)}${rate}${a.verdict !== 'ok' ? ' ' + a.verdict : ''}${five}`;
}

// Same weekly window? resetsAt can differ by sub-second jitter between sources
// (OAuth ISO with fractional seconds vs the status line's whole seconds); a new
// week moves it by days.
const sameWeek = (a, b) => Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) < 6 * HOUR : a === b;

module.exports = { sameWeek, fetchQuota, sessionStatus, weeklyProjection, thresholds, verdictFor, assess, describe, fmtWhen, pct };
