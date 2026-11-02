'use strict';
// scripts/soa-weekly-guard.cjs — the weekly verdict shared by soa-sessions usage,
// soa-usage-alert and soa-usage-throttle (the 5h window is being retired).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

const G = require(path.join(__dirname, '..', '..', 'scripts', 'soa-weekly-guard.cjs'));

const H = 3600000;
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const weekly = (used, hoursLeft, extra = {}) => ({ usedPercent: used, windowMinutes: 10080, resetsAt: NOW + hoursLeft * H, updatedAt: NOW, ...extra });
const session = (used, hoursLeft) => ({ usedPercent: used, windowMinutes: 300, resetsAt: NOW + hoursLeft * H, updatedAt: NOW });

test('session status: reported, retired, not-reported, stale, env override', () => {
    assert.strictEqual(G.sessionStatus('claude', { windows: { session: session(10, 2) } }, NOW, {}), 'reported');
    assert.strictEqual(G.sessionStatus('claude', { windows: { session: null }, windowStatus: { session: 'retired' } }, NOW, {}), 'retired');
    assert.strictEqual(G.sessionStatus('codex', { windows: { session: null }, windowStatus: { session: 'not-reported' } }, NOW, {}), 'not-reported');
    // A five_hour whose reset already passed is not a current reading.
    assert.strictEqual(G.sessionStatus('claude', { windows: { session: session(10, -1) } }, NOW, {}), 'not-reported');
    assert.strictEqual(G.sessionStatus('claude', { windows: { session: session(10, 2) } }, NOW, { SOA_QUOTA_CLAUDE_SESSION: 'off' }), 'retired');
    assert.strictEqual(G.sessionStatus('claude', { windows: { session: session(10, 2) }, windowStatus: { session: 'not-reported' } }, NOW, { SOA_QUOTA_CLAUDE_SESSION: 'on' }), 'reported');
    // =on never resurrects a reading whose window already reset.
    assert.strictEqual(G.sessionStatus('claude', { windows: { session: session(10, -1) } }, NOW, { SOA_QUOTA_CLAUDE_SESSION: 'on' }), 'not-reported');
    // The override is Claude-only.
    assert.strictEqual(G.sessionStatus('codex', { windows: { session: session(10, 2) } }, NOW, { SOA_QUOTA_CLAUDE_SESSION: 'off' }), 'reported');
    assert.strictEqual(G.sessionStatus('claude', null, NOW, {}), 'not-reported');
});

test('weekly projection: pace when estimated, week-to-date average otherwise', () => {
    // 84h elapsed at 42% = 0.5%/h average; 84h left → 84%.
    const avg = G.weeklyProjection({ windows: { weekly: weekly(42, 84) }, pace: { weekly: { state: 'warming' } } }, NOW);
    assert.strictEqual(avg.basis, 'average');
    assert.ok(Math.abs(avg.projected - 84) < 1e-9);
    assert.strictEqual(avg.runsOutBeforeReset, false);
    // Current pace (1%/h) for the next 5h, then the 0.5%/h average: 42 + 5 + 39.5.
    const pace = G.weeklyProjection({ windows: { weekly: weekly(42, 84) }, pace: { weekly: { state: 'estimated', percentPerHour: 1 } } }, NOW, {});
    assert.strictEqual(pace.basis, 'pace+avg');
    assert.ok(Math.abs(pace.projected - 86.5) < 1e-9);
    assert.strictEqual(pace.runsOutBeforeReset, false);
    // A 10-minute burst is not extrapolated across four days (was 3000%+ for Codex)...
    const burst = G.weeklyProjection({ windows: { weekly: weekly(42, 84) }, pace: { weekly: { state: 'estimated', percentPerHour: 30 } } }, NOW, {});
    assert.ok(Math.abs(burst.projected - (42 + 150 + 39.5)) < 1e-9);
    // ...but a pace that empties the week within the near term says so.
    assert.strictEqual(burst.runsOutBeforeReset, true);
    assert.ok(Math.abs(burst.runOutAt - (NOW + (58 / 30) * H)) < 1);
    // Fresh week: the average is spread over at least 24h, and a burst pace only
    // covers the near term — 30 minutes in, one Codex tick no longer reads 4000%.
    const fresh = G.weeklyProjection({ windows: { weekly: weekly(2, 167.5) }, pace: { weekly: { state: 'estimated', percentPerHour: 0.5 } } }, NOW, {});
    assert.strictEqual(fresh.basis, 'pace+avg');
    assert.ok(Math.abs(fresh.projected - (2 + 0.5 * 5 + (2 / 24) * 162.5)) < 1e-9);
    const tick = G.weeklyProjection({ windows: { weekly: weekly(3, 167.5) }, pace: { weekly: { state: 'estimated', percentPerHour: 24 } } }, NOW, {});
    assert.ok(tick.projected < 200, `first-tick projection ${tick.projected}`);
    // 6% in the first 2h of the week is not 3%/h for seven days (was 504% → THROTTLE).
    const early = G.weeklyProjection({ windows: { weekly: weekly(6, 166) }, pace: { weekly: { state: 'warming' } } }, NOW, {});
    assert.ok(Math.abs(early.projected - (6 + (6 / 24) * 166)) < 1e-9);
    assert.strictEqual(G.verdictFor(early, G.thresholds({}, {})), 'ok');
    // ...but a genuinely heavy start still trips it.
    assert.strictEqual(G.verdictFor(G.weeklyProjection({ windows: { weekly: weekly(30, 166) } }, NOW, {}), G.thresholds({}, {})), 'THROTTLE');
    assert.strictEqual(G.weeklyProjection({ windows: { weekly: weekly(42, 84) }, pace: { weekly: { state: 'estimated', percentPerHour: 1 } } }, NOW, { SOA_WEEK_PACE_HOURS: '84' }).projected, 126);
    // An idle 'steady' sample falls back to the average instead of reading 0%/h.
    assert.strictEqual(G.weeklyProjection({ windows: { weekly: weekly(42, 84) }, pace: { weekly: { state: 'steady', percentPerHour: null } } }, NOW).basis, 'average');
    assert.strictEqual(G.weeklyProjection({ windows: { weekly: weekly(42, -1) } }, NOW), null);
    assert.strictEqual(G.weeklyProjection({ windows: { weekly: null } }, NOW), null);
});

test('verdicts and thresholds (budgets file, then env)', () => {
    const th = G.thresholds({}, {});
    assert.deepStrictEqual(th, { projectedPct: 100, warnPct: 90, usedPct: 95 });
    assert.strictEqual(G.verdictFor({ used: 50, projected: 120 }, th), 'THROTTLE');
    assert.strictEqual(G.verdictFor({ used: 50, projected: 92 }, th), 'WATCH');
    assert.strictEqual(G.verdictFor({ used: 50, projected: 60 }, th), 'ok');
    assert.strictEqual(G.verdictFor({ used: 96, projected: null }, th), 'THROTTLE');
    assert.strictEqual(G.verdictFor(null, th), 'unknown');
    assert.strictEqual(G.thresholds({ weekProjectedPct: 85 }, {}).projectedPct, 85);
    assert.strictEqual(G.thresholds({ weekProjectedPct: 85 }, { SOA_WEEK_PROJECTED_PCT: '70' }).projectedPct, 70);
});

test('assess: Claude retired + Codex not-reported, weekly primary', () => {
    const feed = { data: {
        claude: { windows: { session: null, weekly: weekly(64, 84) }, windowStatus: { session: 'retired', weekly: 'reported' }, primaryWindow: 'weekly', pace: { weekly: { state: 'estimated', percentPerHour: 0.2 } } },
        codex: { windows: { session: null, weekly: weekly(30, 84) }, windowStatus: { session: 'not-reported', weekly: 'reported' } },
    } };
    const a = G.assess(feed, { now: NOW, env: {} });
    assert.strictEqual(a.available, true);
    assert.strictEqual(a.claude.session, 'retired');
    assert.strictEqual(a.claude.sessionReported, false);
    // 64 + 0.2*5 + (64/84)*79 ≈ 125.2 → the week runs out: THROTTLE even with the 5h window gone.
    assert.ok(Math.abs(a.claude.weekly.projected - (65 + (64 / 84) * 79)) < 1e-9);
    assert.strictEqual(a.claude.verdict, 'THROTTLE');
    assert.strictEqual(a.codex.session, 'not-reported');
    assert.strictEqual(a.codex.weekly.basis, 'average');
    assert.match(G.describe('claude', a.claude), /week 64% → 125% .*THROTTLE · 5h retired/);
    assert.strictEqual(G.assess(null, { now: NOW, env: {} }).available, false);
});

test('sameWeek tolerates source jitter, not a new week; assess tolerates odd feeds', () => {
    const R = NOW + 84 * H;
    assert.strictEqual(G.sameWeek(R, R + 391), true);          // OAuth fractional seconds vs status line
    assert.strictEqual(G.sameWeek(R, R + 7 * 24 * H), false);  // the next week
    assert.strictEqual(G.sameWeek(null, null), true);
    assert.strictEqual(G.sameWeek(R, null), false);
    for (const feed of [{ ok: false }, { data: null }, { data: { claude: null, codex: { windows: null } } },
        { data: { claude: { windows: { session: null, weekly: { usedPercent: 50, resetsAt: null } }, windowStatus: { session: 'expired' } } } },
        { data: { claude: { windows: { weekly: { usedPercent: '50', resetsAt: '2026-11-03T17:00:00Z' } } } } }]) {
        const a = G.assess(feed, { now: NOW, env: {} });
        assert.ok(['retired', 'not-reported', 'reported'].includes(a.claude.session));
        assert.ok(['ok', 'WATCH', 'THROTTLE', 'unknown'].includes(a.claude.verdict));
        assert.strictEqual(typeof G.describe('claude', a.claude), 'string');
    }
});

test('fetchQuota honours SOA_QUOTA_FEED_FILE (stub feeds for dry runs)', async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wg-')), 'feed.json');
    fs.writeFileSync(f, JSON.stringify({ ok: true, data: { claude: {} } }));
    const prev = process.env.SOA_QUOTA_FEED_FILE;
    process.env.SOA_QUOTA_FEED_FILE = f;
    try { assert.deepStrictEqual(await G.fetchQuota(), { ok: true, data: { claude: {} } }); }
    finally { if (prev === undefined) delete process.env.SOA_QUOTA_FEED_FILE; else process.env.SOA_QUOTA_FEED_FILE = prev; }
});

test('the CLIs that use it still parse', () => {
    for (const s of ['soa-sessions', 'soa-usage-alert', 'soa-usage-throttle']) {
        execFileSync(process.execPath, ['--check', path.join(__dirname, '..', '..', 'scripts', s)]);
    }
});
