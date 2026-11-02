// Usage-limit banner parsing for the weekly cap (the 5h session limit is being
// retired): banner wordings, zone-aware reset times (the "(Area/City)" suffix,
// DST in that zone, date and year boundaries), the stale-banner guard for dated
// weekly banners, and the end-to-end limited → long timer → prompt replay path.
// Pure + deterministic: Date.now is pinned, no daemon, no PTYs.

const TMP = require('node:path').join(require('node:os').tmpdir(), `soa-web-limit-test-${process.pid}`);
process.env.SOA_WEB_STATE_DIR = TMP;
process.env.SOA_WEB_SUBMIT_DELAY_MS = '5';
delete process.env.SOA_BUS_DIR;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const sm = require('../src/sessionManager');
const { detectLimit, parseResetTime, isStaleBanner, limitWindow, sameReset, SessionManager } = sm;

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

const Z = (s) => Date.parse(s);
const LA = 'America/Los_Angeles';
const H = 3600_000, D = 24 * H;

// ── Wordings ────────────────────────────────────────────────────────────────
test('weekly banner: all-models weekly cap, LA zone, across the Nov 1 DST change', () => {
    const now = Z('2026-10-30T19:00:00Z');                       // Fri Oct 30, 12:00 PDT
    const d = detectLimit("⎿  You've hit your weekly limit · resets Nov 3, 5pm (America/Los_Angeles)\n", now);
    assert.equal(d.agent, 'claude');
    assert.equal(d.window, 'weekly');
    assert.equal(d.tz, LA);
    assert.equal(d.resetAt, Z('2026-11-04T01:00:00Z'), '5pm PST (UTC-8) — DST ended on Nov 1');
    assert.match(d.label, /weekly limit/);
});
test('weekly banner variants: "at", model-scoped, "limit reached", "will reset at", relative days', () => {
    const now = Z('2026-10-30T19:00:00Z');
    let d = detectLimit("You've hit your weekly limit · resets Nov 3 at 5pm (America/Los_Angeles)", now);
    assert.equal(d.resetAt, Z('2026-11-04T01:00:00Z'));
    d = detectLimit("You've hit your Opus weekly limit · resets Nov 3, 5pm (America/Los_Angeles)", now);
    assert.equal(d.window, 'opus weekly');
    assert.equal(d.resetAt, Z('2026-11-04T01:00:00Z'));
    d = detectLimit('Opus weekly limit reached ∙ resets Nov 2, 10am (America/Los_Angeles)', now);
    assert.equal(d.window, 'opus weekly');
    assert.equal(d.resetAt, Z('2026-11-02T18:00:00Z'));
    d = detectLimit('Claude usage limit reached. Your limit will reset at 5pm (America/Los_Angeles).', now);
    assert.equal(d.window, 'usage');
    assert.equal(d.resetAt, Z('2026-10-31T00:00:00Z'), 'today 5pm PDT');
    d = detectLimit("You've hit your weekly limit · resets in 3d 4h", now);
    assert.equal(d.resetAt, now + 3 * D + 4 * H);
    d = detectLimit("You've hit your weekly limit · resets Monday at 5pm (America/Los_Angeles)", now);
    assert.equal(d.resetAt, Z('2026-11-03T01:00:00Z'), 'Mon Nov 2, 5pm PST');
    d = detectLimit('5-hour limit reached ∙ resets 2am (America/Los_Angeles)', now);
    assert.equal(d.window, 'session');
    assert.equal(d.resetAt, Z('2026-10-31T09:00:00Z'), 'tomorrow 2am PDT');
});
test('session banner still parses (it may linger while the 5h limit rolls out)', () => {
    const now = Z('2026-10-30T19:00:00Z');
    const d = detectLimit("You've hit your session limit · resets 9pm (America/Los_Angeles)", now);
    assert.equal(d.window, 'session');
    assert.equal(d.resetAt, Z('2026-10-31T04:00:00Z'));
});
test('a banner wrapped at the terminal width still parses, tz included', () => {
    const now = Z('2026-10-30T19:00:00Z');
    const d = detectLimit("You've hit your weekly\nlimit · resets Nov 3,\n5pm\n(America/Los_Angeles)", now);
    assert.equal(d.resetAt, Z('2026-11-04T01:00:00Z'));
    assert.equal(d.window, 'weekly');
});
test('newest banner wins: a weekly cap painted after an old session banner', () => {
    const now = Z('2026-10-30T19:00:00Z');
    const d = detectLimit("You've hit your session limit · resets 1pm (America/Los_Angeles)\n…\n"
        + "You've hit your weekly limit · resets Nov 3, 5pm (America/Los_Angeles)", now);
    assert.equal(d.window, 'weekly');
});
test('codex banner is unchanged', () => {
    const now = Z('2026-09-29T12:00:00Z');
    const d = detectLimit("■ You've hit your usage limit. Upgrade to Plus to continue using Codex (https://x), or try\nagain at Sep 30th, 2026 3:09 AM.", now);
    assert.equal(d.agent, 'codex');
    assert.equal(d.window, 'usage');
    assert.equal(d.resetAt, new Date(2026, 8, 30, 3, 9).getTime(), 'no zone suffix → daemon-local wall time');
});

// ── Reset-time arithmetic ───────────────────────────────────────────────────
test('parseResetTime honours a zone other than the daemon\'s', () => {
    const now = Z('2026-10-30T10:00:00Z');                       // 19:00 in Tokyo
    assert.equal(parseResetTime('9pm', now, 'Asia/Tokyo'), Z('2026-10-30T12:00:00Z'));
    assert.equal(parseResetTime('5pm', now, 'Asia/Tokyo'), Z('2026-10-31T08:00:00Z'), 'already past today → tomorrow');
    assert.equal(parseResetTime('17:00', now, 'UTC'), Z('2026-10-30T17:00:00Z'), '24h clock');
});
test('parseResetTime: unknown zone falls back to the daemon zone', () => {
    const now = Z('2026-10-30T19:00:00Z');
    assert.equal(parseResetTime('Nov 3, 5pm', now, 'Not/AZone'), parseResetTime('Nov 3, 5pm', now));
    assert.equal(parseResetTime('Nov 3, 5pm', now), new Date(2026, 10, 3, 17, 0).getTime());
});
test('parseResetTime: tomorrow is the next WALL day, not +24h, across fall-back', () => {
    const now = Z('2026-10-31T17:00:00Z');                       // Sat 10:00 PDT
    // 9am Sun Nov 1 is PST: 25 real hours after Sat 9am PDT.
    assert.equal(parseResetTime('9am', now, LA), Z('2026-11-01T17:00:00Z'));
    // 1am Nov 1 happens twice — the first (PDT) one is the reset.
    assert.equal(parseResetTime('1am', now, LA), Z('2026-11-01T08:00:00Z'));
});
test('parseResetTime: spring-forward gap lands on the hour after', () => {
    const now = Z('2027-03-10T12:00:00Z');
    assert.equal(parseResetTime('Mar 14, 2027 2:30am', now, LA), Z('2027-03-14T10:30:00Z'));
    assert.equal(parseResetTime('Mar 15, 2027 9am', now, LA), Z('2027-03-15T16:00:00Z'), 'PDT after the change');
});
test('parseResetTime: undated month/day picks the nearest year (year boundary)', () => {
    assert.equal(parseResetTime('Jan 2, 9am', Z('2026-12-30T12:00:00Z'), 'UTC'), Z('2027-01-02T09:00:00Z'));
    // A passed reset stays in the past — it never jumps to next year.
    assert.equal(parseResetTime('Nov 3, 5pm', Z('2026-11-05T12:00:00Z'), LA), Z('2026-11-04T01:00:00Z'));
    assert.equal(parseResetTime('Dec 30, 5pm', Z('2027-01-01T12:00:00Z'), 'UTC'), Z('2026-12-30T17:00:00Z'));
});
test('parseResetTime: date only → midnight; garbage → null', () => {
    assert.equal(parseResetTime('Nov 3', Z('2026-10-30T19:00:00Z'), LA), Z('2026-11-03T08:00:00Z'));
    assert.equal(parseResetTime('soon', Date.now()), null);
    assert.equal(parseResetTime('Foo 3, 5pm', Date.now()), null);
});
test('limitWindow classifies banner wordings', () => {
    assert.equal(limitWindow("You've hit your weekly limit"), 'weekly');
    assert.equal(limitWindow("You've hit your Sonnet weekly limit"), 'sonnet weekly');
    assert.equal(limitWindow("You've hit your session limit"), 'session');
    assert.equal(limitWindow('5-hour limit reached'), 'session');
    assert.equal(limitWindow("You've hit your limit"), null);
    assert.equal(limitWindow('nothing here'), null);
});

// ── Stale-banner guard ──────────────────────────────────────────────────────
test('a dated weekly banner that lingers past its reset is stale — minutes or days later', () => {
    const banner = "You've hit your weekly limit · resets Nov 3, 5pm (America/Los_Angeles)";
    for (const now of [Z('2026-11-04T01:02:00Z'), Z('2026-11-04T20:00:00Z'), Z('2026-11-08T12:00:00Z')]) {
        const d = detectLimit(banner, now);
        assert.ok(d.resetAt <= now, `resolves to the past at ${new Date(now).toISOString()}`);
        assert.equal(isStaleBanner(d, null, now), true);
    }
    const live = detectLimit(banner, Z('2026-11-03T12:00:00Z'));
    assert.equal(isStaleBanner(live, null, Z('2026-11-03T12:00:00Z')), false);
});
test('sameReset tolerates a relative banner\'s countdown drift, not a new reset', () => {
    const a = detectLimit("You've hit your weekly limit · resets in 3d 4h 10m", 1_000_000).resetAt;
    const b = detectLimit("You've hit your weekly limit · resets in 3d 4h 9m", 1_000_000 + 50_000).resetAt;
    assert.equal(sameReset(a, b), true);
    assert.equal(sameReset(a, a + 2 * H), false);
    assert.equal(sameReset(null, null), true);
    assert.equal(sameReset(a, null), false);
});

// ── End to end: limited → long auto-resume timer → replay ───────────────────
function mkTab(id) {
    const _writes = [];
    return { id, title: `tab${id}`, cwd: '/tmp/proj', exited: false, write(d) { _writes.push(String(d)); }, _writes };
}
test('weekly limit arms a days-long resume, queues rejected prompts, ignores the stale repaint, replays at reset', async () => {
    const realNow = Date.now;
    let now = Z('2026-10-30T19:00:00Z');
    Date.now = () => now;
    try {
        const tab = mkTab(1);
        const tabMgr = { order: [1], get: (id) => (id === 1 ? tab : undefined), scrollback: () => '' };
        const man = new SessionManager({ tabMgr, send() {} });
        man.state.autoResume = true;
        man.state.schedules = [];
        const events = [];
        const origEmit = man._emit.bind(man);
        man._emit = (kind, id, extra) => { events.push(kind); return origEmit(kind, id, extra); };

        man.feedInput(1, 'refactor the parser\r');
        const banner = "\n⎿  You've hit your weekly limit · resets Nov 3, 5pm (America/Los_Angeles)\n";
        man.feed(1, banner);
        const reset = Z('2026-11-04T01:00:00Z');
        assert.equal(events.filter(k => k === 'limited').length, 1);
        const st = man.tabs.get(1);
        assert.equal(st.limit.window, 'weekly');
        assert.equal(st.limit.resetAt, reset);
        const sch = man.state.schedules.find(s => s.tabId === 1 && s.auto);
        assert.ok(sch, 'auto-resume armed');
        assert.equal(sch.at, reset + 2 * 60_000, 'reset + 2 min, ~4.3 days out');
        assert.deepEqual(sch.queued, ['refactor the parser'], 'the rejected prompt is queued');

        // More prompts while limited; the banner is re-painted a day later.
        now += D;
        man.feedInput(1, 'then add tests\r');
        man.feed(1, banner);
        assert.equal(events.filter(k => k === 'limited').length, 1, 'repaint is the same episode');
        assert.deepEqual(man.state.schedules.find(s => s.auto).queued, ['refactor the parser', 'then add tests']);

        // Reset passes → the timer fires and replays in order.
        now = reset + 3 * 60_000;
        man._fireDue();
        await new Promise(r => setTimeout(r, 1200));
        const typed = tab._writes.join('');
        assert.ok(typed.indexOf('refactor the parser') >= 0 && typed.indexOf('then add tests') > typed.indexOf('refactor the parser'), `replayed in order: ${JSON.stringify(typed)}`);
        assert.equal(man.state.schedules.length, 0);

        // The banner stays on screen for days: no second `limited`, no re-arm.
        for (const later of [reset + 10 * 60_000, reset + 13 * H, reset + 3 * D]) {
            now = later;
            man.feed(1, banner);
        }
        assert.equal(events.filter(k => k === 'limited').length, 1);
        assert.equal(man.state.schedules.length, 0);

        // A genuinely new weekly cap (next week) arms normally.
        man.feed(1, "\nYou've hit your weekly limit · resets Nov 10, 5pm (America/Los_Angeles)\n");
        assert.equal(events.filter(k => k === 'limited').length, 2);
        assert.equal(man.state.schedules.find(s => s.auto).at, Z('2026-11-11T01:00:00Z') + 2 * 60_000);
    } finally {
        Date.now = realNow;
    }
});

// ── Review regressions ──────────────────────────────────────────────────────
test('"limit reached" needs a quota qualifier: rate/context limits are not caps', () => {
    const now = Z('2026-10-30T19:00:00Z');
    assert.equal(detectLimit('API Error: Rate limit reached. Please try again later; quota resets at 17:00', now), null);
    assert.equal(detectLimit('Context limit reached · resets in 2h', now), null);
    assert.equal(detectLimit('Opus weekly limit reached ∙ resets Nov 3, 10am', now).window, 'opus weekly');
    assert.equal(detectLimit('5-hour limit reached ∙ resets 2am', now).window, 'session');
    assert.equal(detectLimit('Claude usage limit reached. Your limit will reset at 5pm (America/Los_Angeles).', now).window, 'usage');
});

test('a relative weekly banner lingering on screen is ONE episode: no re-arm, queue kept, no re-arm after the reset', async () => {
    const realNow = Date.now;
    const t0 = Z('2026-10-30T19:00:00Z');
    let now = t0;
    Date.now = () => now;
    try {
        const tab = mkTab(1);
        const tabMgr = { order: [1], get: (id) => (id === 1 ? tab : undefined), scrollback: () => '' };
        const man = new SessionManager({ tabMgr, send() {} });
        man.state.autoResume = true;
        man.state.schedules = [];
        let limited = 0;
        const origEmit = man._emit.bind(man);
        man._emit = (kind, id, extra) => { if (kind === 'limited') limited++; return origEmit(kind, id, extra); };
        const banner = "\nYou've hit your weekly limit · resets in 3d 4h\n";
        man.feedInput(1, 'first ask\r');
        man.feed(1, banner);
        for (let i = 0; i < 12; i++) {           // repainted every 10 min for 2h
            now += 10 * 60_000;
            if (i === 3) man.feedInput(1, 'second ask\r');
            man.feed(1, banner);
        }
        assert.equal(limited, 1);
        const sch = man.state.schedules.filter(s => s.auto);
        assert.equal(sch.length, 1);
        assert.equal(sch[0].at, t0 + 3 * D + 4 * H + 2 * 60_000, 'anchored to the first paint, not sliding');
        assert.deepEqual(sch[0].queued, ['first ask', 'second ask']);
        // A ticking countdown (text changes, instant stable) is the same episode too.
        man.feed(1, "\nYou've hit your weekly limit · resets in 3d 1h 59m\n");
        assert.equal(limited, 1);
        // The reset passes and the old text lingers: stale, not a new cap.
        now = t0 + 3 * D + 4 * H + 3 * 60_000;
        man._fireDue();
        await new Promise(r => setTimeout(r, 300));
        man.feed(1, banner);
        assert.equal(limited, 1);
        assert.equal(man.state.schedules.filter(s => s.auto).length, 0);
    } finally {
        Date.now = realNow;
    }
});
