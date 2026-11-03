// Claude's official quota: the live poll keeps the numbers current while the
// fleet idles; status-line records remain the fallback; nothing secret leaks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = path.join(os.tmpdir(), `soa-claude-quota-${process.pid}`);
process.env.SOA_WEB_STATE_DIR = TMP;
const { ClaudeQuota, normalizeOfficial, snapshot } = require('../src/claudeQuota');

const DIR = path.join(TMP, 'claude-quota');
const iso = (ms) => new Date(ms).toISOString();
const official = (fh, sd, now) => ({ five_hour: { utilization: fh, resets_at: iso(now + 3600e3) }, seven_day: { utilization: sd, resets_at: iso(now + 86400e3) } });
function writeRecord(fh, sd, updatedAt, now) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, 'a'.repeat(64) + '.json'), JSON.stringify({ version: 1, source: 'claude-code-statusline',
        windows: { five_hour: { used_percentage: fh, resets_at: Math.floor((now + 1800e3) / 1000) }, seven_day: { used_percentage: sd, resets_at: Math.floor((now + 86400e3) / 1000) } },
        updatedAt, receivedAt: updatedAt, signature: 'x' }));
}
function make({ replies, cred = { accessToken: 'tok-secret', expiresAt: Date.now() + 3600e3 }, enabled = true } = {}) {
    let clock = Date.now();
    const calls = [];
    const fetch = async (url, init) => { calls.push({ url, init }); const r = replies.shift() || { status: 200, json: official(8, 95, clock) }; return { ok: r.status < 400, status: r.status, json: async () => r.json }; };
    const q = new ClaudeQuota({ directory: DIR, now: () => clock, fetch, credentials: cb => cb(cred), refreshMs: 60000, enabled });
    return { q, calls, tick: ms => { clock += ms; } };
}

test.beforeEach(() => { fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true }); });
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('normalizeOfficial: utilization + ISO reset → windows; no reset = a fresh 0% window; expired dropped', () => {
    const now = Date.now();
    const w = normalizeOfficial({ five_hour: { utilization: 8, resets_at: iso(now + 60e3) }, seven_day: { utilization: 0, resets_at: null } }, now);
    assert.equal(w.session.usedPercent, 8); assert.equal(w.session.windowMinutes, 300); assert.equal(w.session.resetsAt, now + 60e3);
    assert.equal(w.weekly.usedPercent, 0); assert.equal(w.weekly.resetsAt, null);
    const e = normalizeOfficial({ five_hour: { utilization: 50, resets_at: iso(now - 1) }, seven_day: { utilization: 3, resets_at: iso(now + 5) } }, now);
    assert.equal(e.session, null); assert.equal(e.weekly.usedPercent, 3);
    assert.throws(() => normalizeOfficial({}, now));
});

test('the live poll wins over an older status-line record and carries the bearer, never logging it', async () => {
    const { q, calls } = make({ replies: [{ status: 200, json: official(8, 95, Date.now()) }] });
    writeRecord(6, 90, Date.now() - 2 * 3600e3, Date.now());   // the "Cached · 2h ago" state
    await q.refresh();
    const s = q.snapshot(false);
    assert.equal(calls[0].init.headers.authorization, 'Bearer tok-secret');
    assert.equal(s.windows.session.usedPercent, 8);
    assert.equal(s.windows.weekly.usedPercent, 95);
    assert.equal(s.windows.session.source, 'claude-oauth-usage');
    assert.equal(s.source, 'claude-oauth-usage');
    assert.equal(s.status, 'ready');
    assert.equal(s.official.ok, true);
    assert.equal(JSON.stringify(s).includes('tok-secret'), false);
});

test('without a credential, the status-line record still answers and the reason is named', async () => {
    const { q, calls } = make({ replies: [], cred: null });
    writeRecord(6, 90, Date.now() - 60e3, Date.now());
    await q.refresh();
    const s = q.snapshot(false);
    assert.equal(calls.length, 0);
    assert.equal(s.windows.weekly.usedPercent, 90);
    assert.equal(s.windows.weekly.source, 'claude-code-statusline');
    assert.match(s.official.error, /no Claude Code credential/);
    assert.equal(s.status, 'ready');
});

test('an expired session record with no live poll is "waiting" for that window, not a stale number', async () => {
    const { q, tick } = make({ replies: [], cred: null });
    const now = Date.now();
    writeRecord(6, 90, now - 3 * 3600e3, now);
    tick(2 * 3600e3);                       // the 5h window's reset (now+30m) has passed
    const s = q.snapshot(false);
    assert.equal(s.windows.session, null);
    assert.equal(s.windows.weekly.usedPercent, 90);
    assert.equal(s.status, 'stale');
});

test('401 backs off ten minutes; an expired token defers to Claude Code; polls are rate-limited', async () => {
    const { q, calls, tick } = make({ replies: [{ status: 401, json: {} }] });
    await q.refresh();
    assert.match(q.lastError, /unauthorized/);
    tick(60001); await q.refresh();
    assert.equal(calls.length, 1, 'backed off');
    tick(10 * 60000); await q.refresh();
    assert.equal(calls.length, 2);
    const { q: q2, calls: c2 } = make({ replies: [], cred: { accessToken: 'x', expiresAt: Date.now() - 1 } });
    await q2.refresh();
    assert.equal(c2.length, 0);
    assert.match(q2.lastError, /expired/);
    const { q: q3, calls: c3, tick: t3 } = make({ replies: [] });
    await q3.refresh(); await q3.refresh(); t3(59000); await q3.refresh();
    assert.equal(c3.length, 1, 'one poll per refresh window');
    t3(2000); await q3.refresh();
    assert.equal(c3.length, 2);
});

test('a live poll older than five minutes goes stale and a newer record can overtake it', async () => {
    const { q, tick } = make({ replies: [{ status: 200, json: official(8, 95, Date.now()) }] });
    await q.refresh();
    tick(6 * 60000);
    assert.equal(q.snapshot(false).status, 'stale');
    writeRecord(12, 96, Date.now() + 6 * 60000, Date.now() + 6 * 60000);
    const s = q.snapshot(false);
    assert.equal(s.windows.session.usedPercent, 12);
    assert.equal(s.windows.session.source, 'claude-code-statusline');
});

test('opted out (SOA_QUOTA_OAUTH=0) never fetches; the legacy snapshot() stays record-only', async () => {
    const { q, calls } = make({ replies: [], enabled: false });
    await q.refresh();
    assert.equal(calls.length, 0);
    writeRecord(6, 90, Date.now(), Date.now());
    assert.equal(snapshot({ directory: DIR }).windows.session.usedPercent, 6);
});

// ── Weekly-primary contract (2026-10-30): the 5h session limit is being retired ──
const { QuotaPace } = require('../src/quotaPace');
function writeRaw(windows, updatedAt, name = 'b') {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, name.repeat(64) + '.json'), JSON.stringify({ version: 1, source: 'claude-code-statusline',
        windows, updatedAt, receivedAt: updatedAt, signature: 'x' }));
}

test('five_hour present → session reported; weekly is the primary window', async () => {
    delete process.env.SOA_QUOTA_CLAUDE_SESSION;
    const { q } = make({ replies: [{ status: 200, json: official(8, 64, Date.now()) }] });
    await q.refresh();
    const s = q.snapshot(false);
    assert.equal(s.primaryWindow, 'weekly');
    assert.deepEqual(s.windowStatus, { session: 'reported', weekly: 'reported' });
    assert.equal(s.windows.session.usedPercent, 8);
    assert.equal(s.official.carriesSession, true);
    const paced = new QuotaPace().sample({ claude: s, codex: { available: false, windows: {} } });
    assert.equal(paced.claude.primaryWindow, 'weekly');
    assert.equal(paced.codex.primaryWindow, 'weekly');
});

test('five_hour absent from the live poll AND every current record → retired (one ring, no pace)', async () => {
    delete process.env.SOA_QUOTA_CLAUDE_SESSION;
    const now = Date.now();
    const { q } = make({ replies: [{ status: 200, json: { five_hour: null, seven_day: { utilization: 64, resets_at: iso(now + 86400e3) } } }] });
    writeRaw({ seven_day: { used_percentage: 63, resets_at: Math.floor((now + 86400e3) / 1000) } }, now - 60e3);
    await q.refresh();
    const s = q.snapshot(false);
    assert.equal(s.windows.session, null);
    assert.equal(s.windowStatus.session, 'retired');
    assert.equal(s.windowStatus.weekly, 'reported');
    assert.equal(s.windows.weekly.usedPercent, 64);
    assert.equal(s.official.carriesSession, false);
    assert.deepEqual(new QuotaPace().sample({ claude: s, codex: {} }).claude.pace.session, { state: 'retired' });
    // Status-line only (poll unavailable), records without five_hour → retired too.
    const { q: q2 } = make({ replies: [], cred: null });
    assert.equal(q2.snapshot(false).windowStatus.session, 'retired');
});

test('a stale five_hour whose reset has passed is never shown as current', async () => {
    delete process.env.SOA_QUOTA_CLAUDE_SESSION;
    const now = Date.now();
    // Record written before its reset; the reset is now in the past.
    writeRaw({ five_hour: { used_percentage: 77, resets_at: Math.floor((now - 60e3) / 1000) },
               seven_day: { used_percentage: 64, resets_at: Math.floor((now + 86400e3) / 1000) } }, now - 2 * 3600e3);
    const { q } = make({ replies: [], cred: null });
    const s = q.snapshot(false);
    assert.equal(s.windows.session, null, 'no source carries a CURRENT five_hour');
    assert.equal(s.windowStatus.session, 'not-reported', 'the newest record still carries a (lapsed) five_hour: the limit exists');
    // The live poll returning an expired five_hour: not current, but the limit still exists.
    const { q: q2 } = make({ replies: [{ status: 200, json: { five_hour: { utilization: 90, resets_at: iso(now - 1) },
        seven_day: { utilization: 64, resets_at: iso(now + 86400e3) } } }] });
    await q2.refresh();
    const s2 = q2.snapshot(false);
    assert.equal(s2.windows.session, null);
    assert.equal(s2.windowStatus.session, 'not-reported');
});

test('SOA_QUOTA_CLAUDE_SESSION=off forces retired; =on never retires', async () => {
    const now = Date.now();
    try {
        process.env.SOA_QUOTA_CLAUDE_SESSION = 'off';
        const { q } = make({ replies: [{ status: 200, json: official(8, 64, now) }] });
        await q.refresh();
        const s = q.snapshot(false);
        assert.equal(s.windows.session, null, 'hidden even though reported');
        assert.equal(s.windowStatus.session, 'retired');
        assert.equal(s.sessionMode, 'off');
        assert.equal(s.windows.weekly.usedPercent, 64);

        process.env.SOA_QUOTA_CLAUDE_SESSION = 'on';
        const { q: q2 } = make({ replies: [{ status: 200, json: { seven_day: { utilization: 64, resets_at: iso(now + 86400e3) } } }] });
        await q2.refresh();
        const s2 = q2.snapshot(false);
        assert.equal(s2.windows.session, null);
        assert.equal(s2.windowStatus.session, 'not-reported');
        assert.equal(s2.sessionMode, 'on');
    } finally { delete process.env.SOA_QUOTA_CLAUDE_SESSION; }
    // A constructor option overrides the env.
    const q3 = new ClaudeQuota({ directory: DIR, enabled: false, sessionMode: 'off' });
    assert.equal(q3.snapshot(false).windowStatus.session, 'retired');
});

test('nothing reported yet (no poll, no records) → not-reported, never a guessed retirement', () => {
    delete process.env.SOA_QUOTA_CLAUDE_SESSION;
    const { q } = make({ replies: [], cred: null });
    const s = q.snapshot(false);
    assert.equal(s.status, 'waiting');
    assert.equal(s.windowStatus.session, 'not-reported');
    assert.equal(s.windowStatus.weekly, 'not-reported');
});

test('a poll outage after the 5h window lapsed does not retire it', async () => {
    delete process.env.SOA_QUOTA_CLAUDE_SESSION;
    const now = Date.now();
    const { q, tick } = make({ replies: [{ status: 200, json: { five_hour: { utilization: 40, resets_at: iso(now + 60e3) },
        seven_day: { utilization: 50, resets_at: iso(now + 86400e3) } } }] });
    await q.refresh();
    assert.equal(q.snapshot(false).windowStatus.session, 'reported');
    tick(2 * 60e3);
    assert.equal(q.snapshot(false).windowStatus.session, 'not-reported');
    tick(10 * 60e3);   // the poll is now stale (outage): still not retired
    const s = q.snapshot(false);
    assert.equal(s.official.ok, false);
    assert.equal(s.windowStatus.session, 'not-reported');
    assert.equal(new QuotaPace().sample({ claude: s, codex: {} }).claude.pace.session.state, 'unavailable');
});

test('retirement follows the NEWEST report: live poll vs status-line record', async () => {
    delete process.env.SOA_QUOTA_CLAUDE_SESSION;
    const now = Date.now();
    const lapsed = { used_percentage: 30, resets_at: Math.floor((now - 3600e3) / 1000) };
    const week = { used_percentage: 60, resets_at: Math.floor((now + 86400e3) / 1000) };
    // Newer poll without five_hour beats an older record that carried a lapsed one.
    writeRaw({ five_hour: lapsed, seven_day: week }, now - 2 * 3600e3);
    const { q } = make({ replies: [{ status: 200, json: { seven_day: { utilization: 60, resets_at: iso(now + 86400e3) } } }] });
    await q.refresh();
    assert.equal(q.snapshot(false).windowStatus.session, 'retired');
    // Status-line only: newest record without five_hour → retired even if an older one carried it.
    writeRaw({ five_hour: null, seven_day: week }, now - 60e3, 'c');
    const { q: q2 } = make({ replies: [], cred: null });
    assert.equal(q2.snapshot(false).windowStatus.session, 'retired');
    // A newer record that still carries a five_hour beats an older poll without one.
    fs.rmSync(path.join(DIR, 'c'.repeat(64) + '.json'));
    const { q: q3, tick } = make({ replies: [{ status: 200, json: { seven_day: { utilization: 60, resets_at: iso(now + 86400e3) } } }] });
    await q3.refresh();
    tick(5e3);
    writeRaw({ five_hour: lapsed, seven_day: week }, now + 5e3, 'd');
    assert.equal(q3.snapshot(false).windowStatus.session, 'not-reported');
});
