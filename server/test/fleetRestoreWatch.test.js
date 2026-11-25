// scripts/soa-fleet-restore-watch — decision logic and state-dir resolution.
// The 2026-11-25 failure: the watcher read a previous install's state dir and
// restored through the license-gated soa-restore-fleet (every spawn failed).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const watch = require('../../scripts/soa-fleet-restore-watch');

const config = { enabled: true, dry: false, cooldownMs: 600000, minUptimeMs: 90000, debounceMs: 45000 };
const lastgood = { savedAt: '2026-11-25T21:07:00.000Z', tabs: [{ cwd: '/a' }, { cwd: '/b' }, { cwd: '/c' }] };
const base = { liveCount: 1, lastgood, meta: null, uptimeMs: 10 * 60 * 1000, cursor: null, now: 1_000_000_000, config };

test('healthy fleet → ok and the collapse latch clears', () => {
    const d = watch.decide({ ...base, liveCount: 37, cursor: { collapseSince: 5 } });
    assert.equal(d.action, 'ok');
    assert.equal(d.cursor.collapseSince, 0);
});

test('collapse inside the rehydrate window waits', () => {
    assert.equal(watch.decide({ ...base, uptimeMs: 30000 }).action, 'wait');
});

test('collapse arms, holds during debounce, then restores', () => {
    const a = watch.decide(base);
    assert.equal(a.action, 'arm');
    assert.equal(watch.decide({ ...base, cursor: a.cursor, now: base.now + 10000 }).action, 'hold');
    assert.equal(watch.decide({ ...base, cursor: a.cursor, now: base.now + 50000 }).action, 'restore');
});

test('cooldown after a recent restore', () => {
    const cursor = { collapseSince: base.now - 60000, lastRestoreAt: base.now - 60000 };
    assert.equal(watch.decide({ ...base, cursor }).action, 'cooldown');
});

test('a user close-all is respected', () => {
    const meta = { savedAt: '2026-11-25T21:30:00.000Z', tabs: [], closedByUser: true, userCloses: 3 };
    assert.equal(watch.decide({ ...base, meta }).action, 'ok');
});

test('the shutdown tombstone (no user close, right after lastgood) is not intent', () => {
    const meta = { savedAt: '2026-11-25T21:07:00.600Z', tabs: [], closedByUser: true };
    assert.equal(watch.intentionalCloseAll(meta, lastgood), false);
    assert.equal(watch.decide({ ...base, meta }).action, 'arm');
});

test('resolveStateDir: env override wins', () => {
    assert.equal(watch.resolveStateDir({ env: { SOA_WEB_STATE_DIR: '~/x/state' }, home: '/h' }), '/h/x/state');
});

test('resolveStateDir: picks the dir whose daemon.lock pid is alive, not a stale install', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-frw-'));
    const mk = (rel, lock) => {
        const d = path.join(home, rel); fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'daemon.lock'), JSON.stringify(lock));
        return d;
    };
    mk('.soa-web-local', { pid: 111, port: 4010, startedAt: '2026-11-25T20:00:00Z' });  // old, dead
    const liveDir = mk('.s0a-local/state', { pid: 222, port: 4010, startedAt: '2026-11-25T21:07:14Z' });
    const got = watch.resolveStateDir({ env: {}, home, alive: pid => pid === 222 });
    assert.equal(got, liveDir);
    fs.rmSync(home, { recursive: true, force: true });
});
