// soa-usage-alert: one digest push per cycle; its log/state follow SOA_WEB_STATE_DIR.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-usage-alert-test-'));
process.env.HOME = TMP;                         // never touch the real ~/.soa-web
process.env.SOA_WEB_STATE_DIR = path.join(TMP, 'state');
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const { buildDigest, digestDue } = require('../../scripts/soa-usage-alert');
const paths = require('../../scripts/soa-usage-paths.cjs');

const s = (label, key, reasons = [`$${key} today`]) => ({ label, key, reasons });

test('digest: N sessions → one push, ranked by cost, capped with "+k more"', () => {
    const d = buildDigest({ sessions: [s('#2 web', 70), s('#5 api', 120), s('#7 docs', 61), s('#9 ops', 90)], top: 3, tail: 'Week 40% → 80% at reset.' });
    assert.equal(d.title, 'SoA token alert — 4 sessions');
    const lines = d.body.split('\n');
    assert.deepEqual(lines.slice(0, 3).map(l => l.match(/“(.+)”/)[1]), ['#5 api', '#9 ops', '#2 web']);
    assert.equal(lines[3], '+1 more');
    assert.equal(lines[4], 'Week 40% → 80% at reset.');
    assert.equal(d.tags, 'warning,fire');
    assert.deepEqual(d.named.map(x => x.label), ['#5 api', '#9 ops', '#2 web'], 'only the named sessions start their cooldown');
    // A tie in the primary scope (e.g. every 5h block at $0) falls back to today$.
    const tie = buildDigest({ sessions: [{ label: 'a', reasons: ['x'], key: 0, today: 70 }, { label: 'b', reasons: ['x'], key: 0, today: 110 }], top: 1 });
    assert.match(tie.body, /“b”/); assert.match(tie.body, /\+1 more/);
});

test('digest gap: at most one digest per gap; a clock step back never blocks', () => {
    const now = 1800000000000;
    assert.equal(digestDue(0, now, 600), true);
    assert.equal(digestDue(now - 599000, now, 600), false);
    assert.equal(digestDue(now - 600000, now, 600), true);
    assert.equal(digestDue(now + 60000, now, 600), true);
});

test('digest: the weekly projection merges into the same push, first', () => {
    const d = buildDigest({ week: ['⚠ Weekly quota: Claude is at 92%'], sessions: [s('#1 a', 65)], top: 3 });
    assert.equal(d.title, 'SoA token alert — weekly quota + 1 session');
    assert.match(d.body.split('\n')[0], /^⚠ Weekly quota/);
    const w = buildDigest({ week: ['⚠ Weekly quota: Codex'], sessions: [], tail: 'ignored without sessions' });
    assert.equal(w.title, 'SoA weekly quota'); assert.equal(w.body, '⚠ Weekly quota: Codex'); assert.equal(w.tags, 'warning,hourglass');
    assert.equal(buildDigest({ week: [], sessions: [] }), null);
});

test('log dir: $SOA_WEB_STATE_DIR/logs, else the legacy ~/.soa-web/logs; legacy state is migrated once', () => {
    const home = path.join(TMP, 'h');
    assert.equal(paths.usageLogDir({}, home), path.join(home, '.soa-web', 'logs'));
    assert.equal(paths.usageLogDir({ SOA_WEB_STATE_DIR: '/x/state' }, home), '/x/state/logs');
    const old = path.join(home, '.soa-web', 'logs');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, '.usage-alert-state.json'), '{"sessions":{"a":{}}}');
    const env = { SOA_WEB_STATE_DIR: path.join(TMP, 'st2') };
    const file = paths.usageStateFile('.usage-alert-state.json', env, home);
    assert.equal(file, path.join(TMP, 'st2', 'logs', '.usage-alert-state.json'));
    assert.equal(fs.readFileSync(file, 'utf8'), '{"sessions":{"a":{}}}');
    fs.writeFileSync(file, '{"sessions":{}}');
    assert.equal(fs.readFileSync(paths.usageStateFile('.usage-alert-state.json', env, home), 'utf8'), '{"sessions":{}}', 'never re-migrated over newer state');
    // Readers take the fresher copy, whichever dir it is in.
    const t = Date.now() / 1000;
    fs.utimesSync(path.join(old, '.usage-alert-state.json'), t - 600, t - 600);
    fs.utimesSync(file, t, t);
    assert.equal(paths.newestUsageStateFile('.usage-alert-state.json', env, home), file);
    assert.equal(paths.newestUsageStateFile('.usage-alert-state.json', {}, home), path.join(old, '.usage-alert-state.json'));
    assert.equal(paths.newestUsageStateFile('.missing.json', env, home), null);
});
