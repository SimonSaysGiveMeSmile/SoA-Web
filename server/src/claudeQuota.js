// Claude's official quota (the 5-hour session and 7-day windows), from two
// sources merged newest-first:
//
//   1. LIVE POLL of the official usage endpoint with the Claude Code OAuth
//      credential already on this machine (macOS keychain "Claude Code-
//      credentials", or ~/.claude/.credentials.json). Read-only, in memory,
//      never logged or persisted; every 60 s. This is what keeps the numbers
//      current while the fleet is idle — until 2026-09-29 the only source was
//      (2) and an idle hour left the widget showing a stale weekly figure and
//      a session window that had quietly expired into "Not reported".
//   2. STATUS-LINE RECORDS written by ~/.claude/hooks/soa-usage-statusline.cjs
//      whenever a Claude Code session repaints (claude-quota/*.json). Still
//      the fallback when the poll cannot run (no credential, token expired
//      until Claude Code refreshes it, offline, opted out with
//      SOA_QUOTA_OAUTH=0).
//
// The WEEKLY window is the primary one (2026-10-30): Anthropic is removing the
// 5-hour session limit. The session window is reported only while a source
// still carries a CURRENT five_hour. With no current one, the NEWEST report
// (last live-poll payload vs newest status-line record) decides: if it still
// carries a five_hour (lapsed) the status is 'not-reported'; if it carries none,
// windowStatus.session is 'retired' (the provider no longer has a 5h limit) and
// the UI drops that ring. A poll outage alone never retires it. SOA_QUOTA_CLAUDE_SESSION=off forces 'retired'; =on never retires it
// (an absent window then reads 'not-reported'). Default: auto.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('node:child_process');
const { STATE_DIR } = require('./stateDir');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const STALE_MS = 5 * 60 * 1000;
const PRIMARY_WINDOW = 'weekly';

/** SOA_QUOTA_CLAUDE_SESSION → 'auto' | 'on' | 'off'. */
function sessionModeFrom(value) {
    const v = String(value == null ? '' : value).trim().toLowerCase();
    if (['off', '0', 'false', 'no', 'retired'].includes(v)) return 'off';
    if (['on', '1', 'true', 'yes', 'force'].includes(v)) return 'on';
    return 'auto';
}

/** Which windows the raw official payload carries at all (a valid percentage), expired or not. */
function officialCarries(raw) {
    const has = (w) => !!(w && typeof w === 'object' && Number.isFinite(w.utilization) && w.utilization >= 0 && w.utilization <= 100);
    return { session: has(raw && raw.five_hour), weekly: has(raw && raw.seven_day) };
}

/** Whether a status-line record carries a five_hour at all (a valid percentage), lapsed or not. */
function statuslineCarries(record) {
    const w = record && record.windows && record.windows.five_hour;
    return !!(w && typeof w === 'object' && Number.isFinite(w.used_percentage) && w.used_percentage >= 0 && w.used_percentage <= 100);
}

function normalizeWindow(w, minutes, now) {
    if (!w || !Number.isFinite(w.used_percentage) || w.used_percentage < 0 || w.used_percentage > 100 ||
        !Number.isFinite(w.resets_at) || w.resets_at * 1000 <= now) return null;
    return { usedPercent: w.used_percentage, windowMinutes: minutes, resetsAt: w.resets_at * 1000 };
}

/** The official endpoint's shape → our window shape. A window with no reset is a fresh (0%) one. */
function normalizeOfficial(raw, now = Date.now()) {
    if (!raw || typeof raw !== 'object') throw new Error('No usage report');
    const windows = { session: null, weekly: null };
    for (const [key, field, minutes] of [['session', 'five_hour', 300], ['weekly', 'seven_day', 10080]]) {
        const w = raw[field];
        if (!w || typeof w !== 'object') continue;
        const pct = w.utilization;
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) continue;
        if (w.resets_at != null && (typeof w.resets_at !== 'string' || !Number.isFinite(Date.parse(w.resets_at)))) continue;
        const resetsAt = w.resets_at ? Date.parse(w.resets_at) : NaN;
        if (Number.isFinite(resetsAt) && resetsAt <= now) continue;   // an expired window: not current
        windows[key] = { usedPercent: pct, windowMinutes: minutes, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
                         updatedAt: now, source: 'claude-oauth-usage' };
    }
    if (!windows.session && !windows.weekly) throw new Error('Usage report has no windows');
    return windows;
}

function statuslineWindows({ directory, now }) {
    let records = [];
    try {
        records = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
            try {
                const file = path.join(directory, name);
                if (fs.statSync(file).size > 8192) return null;
                return JSON.parse(fs.readFileSync(file, 'utf8'));
            } catch (_) { return null; }
        }).filter(r => r?.version === 1 && r.source === 'claude-code-statusline' &&
            Number.isFinite(r.updatedAt) && r.updatedAt > 0 && r.updatedAt <= now + 5000 &&
            now - r.updatedAt < 8 * 86400000).sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (_) {}
    const windows = { session: null, weekly: null };
    for (const [name, field, minutes] of [['session', 'five_hour', 300], ['weekly', 'seven_day', 10080]]) {
        for (const record of records) {
            const value = normalizeWindow(record.windows?.[field], minutes, now);
            if (value) { windows[name] = { ...value, updatedAt: record.updatedAt, source: 'claude-code-statusline' }; break; }
        }
    }
    return { windows, latest: records[0] || null };
}

// The credential Claude Code already keeps. Only the access token and its
// expiry are used, in memory; nothing is written back and nothing is logged.
function readCredentials(cb, configDirectory = null) {
    const parse = (text) => {
        try {
            const o = JSON.parse(text)?.claudeAiOauth;
            if (o && typeof o.accessToken === 'string' && o.accessToken) return { accessToken: o.accessToken, expiresAt: Number(o.expiresAt) || 0 };
        } catch (_) {}
        return null;
    };
    const directory = configDirectory || path.join(os.homedir(), '.claude');
    // Native Claude Code scopes its Keychain entry to CLAUDE_CONFIG_DIR.
    // Never fall back to the default account for an isolated profile.
    const suffix = configDirectory ? '-' + require('node:crypto').createHash('sha256').update(directory).digest('hex').slice(0, 8) : '';
    if (process.platform === 'darwin') {
        execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials' + suffix, '-w'], { timeout: 4000, maxBuffer: 65536 },
            (err, out) => {
                if (!err && out) return cb(parse(out));
                fs.readFile(path.join(directory, '.credentials.json'), 'utf8', (e2, text) => cb(e2 ? null : parse(text)));
            });
        return;
    }
    fs.readFile(path.join(directory, '.credentials.json'), 'utf8', (e, text) => cb(e ? null : parse(text)));
}

class ClaudeQuota {
    constructor({ directory = path.join(STATE_DIR, 'claude-quota'), now = Date.now, fetch: fetchImpl = globalThis.fetch,
                  credentials = readCredentials, refreshMs = 60000, timeoutMs = 8000,
                  enabled = process.env.SOA_QUOTA_OAUTH !== '0', sessionMode = null, preferOfficial = false } = {}) {
        // null → read SOA_QUOTA_CLAUDE_SESSION on every snapshot.
        this.sessionMode = sessionMode;
        this.directory = directory; this.now = now; this.fetch = fetchImpl; this.credentials = credentials;
        this.refreshMs = refreshMs; this.timeoutMs = timeoutMs; this.enabled = enabled;
        this.official = null;        // { windows, updatedAt, carries }
        this.pending = null; this.attemptAt = 0; this.backoffUntil = 0;
        this.lastError = null;       // a short reason, never the token
        this.preferOfficial = preferOfficial;
        this.minRecordAt = 0;
    }

    async refresh() {
        if (!this.enabled) return;
        if (this.pending) return this.pending;
        const now = this.now();
        if ((this.attemptAt && now - this.attemptAt < this.refreshMs) || now < this.backoffUntil) return;
        this.attemptAt = now;
        this.pending = (async () => {
            try {
                const cred = await new Promise(res => { try { this.credentials(res); } catch (_) { res(null); } });
                if (!cred) { this.lastError = 'no Claude Code credential on this machine'; return; }
                if (cred.expiresAt && cred.expiresAt <= this.now() + 60000) {
                    // Claude Code refreshes it the next time it makes a request;
                    // until then the status-line records carry the numbers.
                    this.lastError = 'credential expired until Claude Code refreshes it';
                    this.backoffUntil = this.now() + 5 * 60000;
                    return;
                }
                const ctl = new AbortController();
                const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
                let res;
                try {
                    res = await this.fetch(USAGE_URL, { signal: ctl.signal, headers: {
                        authorization: `Bearer ${cred.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json',
                    } });
                } finally { clearTimeout(timer); }
                if (res.status === 401 || res.status === 403) { this.lastError = `unauthorized (${res.status})`; this.backoffUntil = this.now() + 10 * 60000; return; }
                if (res.status === 429) { this.lastError = 'rate limited'; this.backoffUntil = this.now() + 5 * 60000; return; }
                if (!res.ok) { this.lastError = `HTTP ${res.status}`; return; }
                const raw = await res.json();
                const windows = normalizeOfficial(raw, this.now());
                this.official = { windows, updatedAt: this.now(), carries: officialCarries(raw) };
                this.lastError = null;
            } catch (e) {
                this.lastError = e && e.name === 'AbortError' ? 'timed out' : (e && e.message || 'failed');
            } finally { this.pending = null; }
        })();
        return this.pending;
    }

    snapshot(refresh = true) {
        if (refresh) void this.refresh();
        const now = this.now();
        const sl = statuslineWindows({ directory: this.directory, now });
        const off = this.official && this.official.windows;
        const officialFresh = !!(off && now - this.official.updatedAt < STALE_MS);
        const windows = {};
        for (const key of ['session', 'weekly']) {
            const a = off ? off[key] : null;
            const b = (this.preferOfficial && off) || (sl.windows[key]?.updatedAt || 0) < this.minRecordAt ? null : sl.windows[key];
            const candidates = [a, b].filter(w => w && (w.resetsAt == null || w.resetsAt > now));
            // Newest report wins; the live poll is newest whenever it is running.
            candidates.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
            windows[key] = candidates[0] || null;
        }
        const mode = sessionModeFrom(this.sessionMode != null ? this.sessionMode : process.env.SOA_QUOTA_CLAUDE_SESSION);
        if (mode === 'off') windows.session = null;
        const windowStatus = { session: 'not-reported', weekly: windows.weekly ? 'reported' : 'not-reported' };
        if (mode === 'off') windowStatus.session = 'retired';
        else if (windows.session) windowStatus.session = 'reported';
        else if (mode === 'on') windowStatus.session = 'not-reported';
        else {
            // No current window. Retire only on the NEWEST evidence: the last
            // live-poll payload (fresh or not: a poll outage is not a
            // retirement) vs the newest status-line record. If that report
            // still carries a five_hour (e.g. one that just lapsed) the limit
            // exists and there is simply no current window to show; with no
            // evidence at all yet (fresh install, nothing polled) don't guess.
            const evidence = [];
            if (this.official && this.official.carries) evidence.push({ at: this.official.updatedAt || 0, carries: !!this.official.carries.session });
            if (sl.latest) evidence.push({ at: sl.latest.updatedAt || 0, carries: statuslineCarries(sl.latest) });
            evidence.sort((x, y) => y.at - x.at);
            windowStatus.session = !evidence.length || evidence[0].carries ? 'not-reported' : 'retired';
        }
        const newest = Math.max(0, ...Object.values(windows).filter(Boolean).map(w => w.updatedAt || 0));
        const any = !!(windows.session || windows.weekly);
        return {
            source: officialFresh ? 'claude-oauth-usage' : 'claude-code-statusline',
            primaryWindow: PRIMARY_WINDOW,
            windows,
            windowStatus,
            sessionMode: mode,
            updatedAt: newest || null,
            receivedAt: sl.latest?.receivedAt || null,
            available: any,
            status: !any ? 'waiting' : now - newest > STALE_MS ? 'stale' : 'ready',
            official: { enabled: this.enabled, ok: officialFresh, at: this.official ? this.official.updatedAt : null, error: this.lastError,
                        carriesSession: this.official && this.official.carries ? this.official.carries.session : null },
        };
    }

    close() {}
}

// Back-compat: the stateless snapshot (status-line records only).
function snapshot({ directory = path.join(STATE_DIR, 'claude-quota'), now = Date.now() } = {}) {
    const q = new ClaudeQuota({ directory, now: () => now, enabled: false });
    return q.snapshot(false);
}

module.exports = { ClaudeQuota, snapshot, normalizeWindow, normalizeOfficial, officialCarries, sessionModeFrom, readCredentials, USAGE_URL, PRIMARY_WINDOW };
