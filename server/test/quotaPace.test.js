// Pace from sparse samples (Claude's official poll, minutes apart and backing
// off on 429) and frequent ones (Codex, every ~15 s); the 429 backoff ladder.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
process.env.SOA_WEB_STATE_DIR = path.join(os.tmpdir(), `soa-quota-pace-${process.pid}`);
const { QuotaPace, MAX_GAP } = require('../src/quotaPace');
const { ClaudeQuota, retryAfterMs } = require('../src/claudeQuota');

const T0 = 1800000000000, MIN = 60000;
const RESET = T0 + 3 * 86400000;
const report = (used, at, { resetsAt = RESET, source = 'claude-oauth-usage' } = {}) => ({
    available: true, status: 'ready', source,
    windows: { weekly: { usedPercent: used, windowMinutes: 10080, resetsAt, updatedAt: at, source } },
});
const pace = (p, r, now) => p.window('claude', 'weekly', r, now);

test('sparse 6-minute samples with a jittering resets_at reach an estimate', () => {
    const p = new QuotaPace();
    assert.equal(pace(p, report(20, T0), T0).state, 'warming');
    // +65 ms of jitter on the reset is the same window, not a reset.
    const r = pace(p, report(21, T0 + 6 * MIN, { resetsAt: RESET + 65 }), T0 + 6 * MIN);
    assert.equal(r.state, 'estimated');
    assert.equal(r.sampledMs, 6 * MIN);
    assert.ok(Math.abs(r.percentPerHour - 10) < 1e-9);
});

test('a stale reading during a backoff keeps the history; the next poll continues it', () => {
    const p = new QuotaPace();
    pace(p, report(20, T0), T0);
    assert.equal(pace(p, report(20, T0), T0 + 20 * MIN).state, 'stale');
    const r = pace(p, report(23, T0 + 30 * MIN), T0 + 30 * MIN);
    assert.equal(r.state, 'estimated'); assert.equal(r.sampledMs, 30 * MIN);
});

test('a real reset, a changed source, a percentage drop or a very long gap restart the history', () => {
    const cases = [
        report(21, T0 + 6 * MIN, { resetsAt: RESET + 7 * 86400000 }),
        report(21, T0 + 6 * MIN, { source: 'claude-code-statusline' }),
        report(19, T0 + 6 * MIN),
    ];
    for (const next of cases) {
        const p = new QuotaPace();
        pace(p, report(20, T0), T0);
        const r = pace(p, next, T0 + 6 * MIN);
        assert.equal(r.state, 'warming'); assert.equal(r.sampledMs, 0);
    }
    const p = new QuotaPace();
    pace(p, report(20, T0), T0);
    const r = pace(p, report(25, T0 + 50 * MIN), T0 + 50 * MIN);
    assert.equal(r.state, 'warming', 'a gap past MAX_GAP is a new observation period');
});

test('3-minute whole-number samples: a one-point tick is not read as a 9-minute rate', () => {
    // Real use 2 %/h from 12%: one tick every 30 min, polled every 3 min.
    const p = new QuotaPace();
    const seen = [];
    for (let t = 0; t <= 120 * MIN; t += 3 * MIN) {
        const r = pace(p, report(12 + Math.floor(t / (30 * MIN)), T0 + t), T0 + t);
        if (t >= 30 * MIN) seen.push(r);
    }
    for (const r of seen) {
        assert.ok(['estimated', 'reset-first'].includes(r.state), `after the first tick every poll keeps an estimate, got ${r.state}`);
        assert.ok(r.percentPerHour >= 1 && r.percentPerHour <= 4, `within 2x of 2 %/h, got ${r.percentPerHour}`);
    }
    assert.ok(seen.some(r => r.sampledMs > 10 * MIN), 'the span comes from the kept hour, not the last 10 minutes');
});

test('frequent samples still use the recent ten minutes', () => {
    const p = new QuotaPace();
    let r;
    // 30 min at 15 s: 0..29 min flat at 10%, then a jump in the last 4 min.
    for (let t = 0; t <= 30 * MIN; t += 15000) {
        const used = t < 26 * MIN ? 10 : 12;
        r = pace(p, report(used, T0 + t), T0 + t);
    }
    assert.equal(r.state, 'estimated');
    assert.equal(r.sampledMs, 10 * MIN, 'span is the recent window, not the whole hour');
    assert.ok(Math.abs(r.percentPerHour - 12) < 1e-9);
});

test('429: capped exponential backoff, a longer Retry-After wins, success resets the ladder', async () => {
    let clock = T0;
    const replies = [];
    const calls = [];
    const ok = () => ({ status: 200, json: { seven_day: { utilization: 9, resets_at: new Date(RESET).toISOString() } } });
    const fetch = async () => {
        calls.push(clock);
        const r = replies.shift() || ok();
        return { ok: r.status < 400, status: r.status, headers: { get: k => (r.headers || {})[k] ?? null }, json: async () => r.json };
    };
    const warn = console.warn; console.warn = () => {};
    test.after(() => { console.warn = warn; });
    const q = new ClaudeQuota({ directory: os.tmpdir(), now: () => clock, fetch, credentials: cb => cb({ accessToken: 'x', expiresAt: 0 }), refreshMs: 60000 });
    const at = async (ms) => { clock = T0 + ms; await q.refresh(); };
    replies.push({ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }, { status: 429 });
    const gaps = [];
    let last = 0;
    await at(0);
    for (let i = 0; i < 5; i++) {
        const until = q.backoffUntil - T0;
        gaps.push((until - last) / MIN);
        assert.equal(q.snapshot(false).official.retryAt, q.backoffUntil);
        await at(until - 1); assert.equal(calls.length, i + 1, 'no call inside the backoff');
        await at(until); last = until;
    }
    assert.deepEqual(gaps, [5, 10, 20, 30, 30]);
    assert.equal(q.lastError, null, 'the sixth call succeeded'); assert.equal(q.rateLimits, 0);
    // After success the ladder starts again; a Retry-After longer than the step wins.
    replies.push({ status: 429, headers: { 'retry-after': '1200' } });
    await at(last + 60000);
    assert.equal(q.backoffUntil - clock, 20 * MIN);
    assert.equal(retryAfterMs(new Date(T0 + 90000).toUTCString(), T0), 90000);
    assert.equal(retryAfterMs('soon', T0), 0);
    assert.equal(retryAfterMs('99999', T0), 40 * MIN, 'capped below the pace MAX_GAP');
    assert.ok(40 * MIN + 3 * MIN < MAX_GAP, 'the longest backoff plus a poll keeps the pace history');
});
