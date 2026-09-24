// The inactive-tab reaper (sessionManager.js _reapInactive): its own opt-in
// flag, a day threshold, persisted first-seen ages, the both-signals-silent
// rule with a fail-closed transcript source, the manager-tab guard, a floor of
// two live tabs, and the hourly throttle. Pure — a fake tabMgr, no PTYs, no
// daemon, no IM (notification stubbed), transcripts fed as a fixture.
const TMP = require('node:path').join(require('node:os').tmpdir(), `soa-web-reap-test-${process.pid}`);
process.env.SOA_WEB_STATE_DIR = TMP;
process.env.SOA_WEB_MANAGER_ENABLED = '1';   // the reaper is gated like its settings surface
delete process.env.SOA_MANAGER_CLOSE_INACTIVE;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { SessionManager } = require('../src/sessionManager');

const DAY = 24 * 60 * 60 * 1000;

function fakeSession(tabs) {
    const byId = new Map(tabs.map(t => [t.id, { ...t, exited: false }]));
    const mgr = {
        order: tabs.map(t => t.id),
        get: (id) => byId.get(id),
        closed: [],
        close(id) { this.closed.push(id); this.order = this.order.filter(x => x !== id); byId.delete(id); },
    };
    return { tabMgr: mgr, activeTab: tabs[0] && tabs[0].id };
}

// A transcript fixture: cwd → newest-session mtime. Non-empty by default so
// the fail-closed guard does not trip.
// Default transcript fixture: every reap-test cwd went quiet 100 days ago,
// so the tests below can express age purely through firstSeen.
const OLD = Date.now() - 100 * DAY;
const DEFAULT_TRANSCRIPTS = new Map(['a','b','c','d','x','y','proj','proj2','old'].map(n => [`/tmp/reap-test/${n}`, { mtime: OLD }]));
function newManager(session, { on = true, days = 1, transcripts = DEFAULT_TRANSCRIPTS } = {}) {
    const m = new SessionManager(session);
    clearInterval(m._schedTimer);
    m.state.autoCloseInactive = on;
    m.state.closeInactiveDays = days;
    m.state.firstSeen = {};
    m.notes = [];
    m._notifyUser = (msg) => m.notes.push(msg);
    m._transcriptsByCwd = () => transcripts;
    m.broadcast = () => {};
    return m;
}

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

test('closes only tabs whose Claude history went quiet for longer than the threshold', () => {
    const s = fakeSession([
        { id: 1, title: 'old-proj', cwd: '/tmp/reap-test/old' },
        { id: 2, title: 'fresh-tab', cwd: '/tmp/reap-test/fresh' },
        { id: 3, title: 'bare-shell', cwd: '/tmp/reap-test/shell' },
        { id: 4, title: 'claude-busy', cwd: '/tmp/reap-test/busy' },
        { id: 5, title: 'noisy-pty', cwd: '/tmp/reap-test/noisy' },
    ]);
    const now = Date.now();
    const m = newManager(s, { days: 1, transcripts: new Map([
        ['/tmp/reap-test/old', { mtime: now - 3 * DAY }],       // Claude last touched it 3 days ago
        ['/tmp/reap-test/fresh', { mtime: now - 3 * DAY }],     // …but the tab was only just opened
        ['/tmp/reap-test/busy', { mtime: now - 60_000 }],       // Claude wrote a minute ago
        ['/tmp/reap-test/noisy', { mtime: now - 3 * DAY }],     // quiet in Claude, chatty PTY
    ]) });
    m.state.firstSeen = {
        '/tmp/reap-test/old': now - 3 * DAY,
        '/tmp/reap-test/fresh': now - 1000,
        '/tmp/reap-test/shell': now - 30 * DAY,                 // no Claude history at all
        '/tmp/reap-test/busy': now - 3 * DAY,
        '/tmp/reap-test/noisy': now - 3 * DAY,
    };
    m._state(5).lastOutputAt = now - 60_000;   // PTY output is NOT activity (supervisors, respawns)
    const closed = m._reapInactive(now);
    assert.deepEqual(s.tabMgr.closed, [1, 5], 'quiet-in-Claude tabs go; a fresh tab, a busy one and a bare shell stay');
    assert.equal(closed.length, 2);
    assert.match(m.notes[0], /Closed 2 tabs inactive for 1\+ days: #1 old-proj, #5 noisy-pty/);
});

test('first-seen is persisted per cwd, not per process', () => {
    const s = fakeSession([{ id: 1, title: 'a', cwd: '/tmp/reap-test/a' }]);
    const m = newManager(s, { days: 30 });
    const now = Date.now();
    m._reapInactive(now);                                    // stamps firstSeen and saves
    assert.equal(m.state.firstSeen['/tmp/reap-test/a'], now);
    const again = new SessionManager(fakeSession([])); clearInterval(again._schedTimer);
    assert.equal(again.state.firstSeen['/tmp/reap-test/a'], now, 'must survive a fresh load from disk');
});

test('never closes a manager tab, however silent', () => {
    const s = fakeSession([
        { id: 1, title: 'manager', cwd: '/tmp/reap-test/x' },
        { id: 2, title: '.soa-web-3', cwd: '/tmp/reap-test/y' },
        { id: 3, title: 'ops', cwd: '/Users/test/.soa-web' },
        { id: 4, title: 'proj', cwd: '/tmp/reap-test/proj' },
        { id: 5, title: 'proj2', cwd: '/tmp/reap-test/proj2' },
    ]);
    const m = newManager(s, { days: 1 });
    const now = Date.now();
    for (const t of [1, 2, 3, 4, 5]) m.state.firstSeen[s.tabMgr.get(t).cwd] = now - 10 * DAY;
    m._reapInactive(now);
    assert.deepEqual(s.tabMgr.closed, [4, 5]);
});

test('does nothing unless the reaper itself is opted in — closeInactive alone is not enough', () => {
    const s = fakeSession([{ id: 1, title: 'old', cwd: '/tmp/reap-test/old' }, { id: 2, title: 'b', cwd: '/tmp/reap-test/b' }, { id: 3, title: 'c', cwd: '/tmp/reap-test/c' }]);
    const m = newManager(s, { on: false, days: 1 });
    m.state.closeInactive = true;                            // the older manager-stop permission
    for (const t of [1, 2, 3]) m.state.firstSeen[s.tabMgr.get(t).cwd] = Date.now() - 30 * DAY;
    assert.equal(m._reapInactive(Date.now()), undefined);
    assert.deepEqual(s.tabMgr.closed, []);
    assert.equal(m.notes.length, 0);
});

test('never reduces the fleet below two live tabs', () => {
    const s = fakeSession([
        { id: 1, title: 'a', cwd: '/tmp/reap-test/a' },
        { id: 2, title: 'b', cwd: '/tmp/reap-test/b' },
        { id: 3, title: 'c', cwd: '/tmp/reap-test/c' },
    ]);
    const m = newManager(s, { days: 1 });
    const now = Date.now();
    for (const t of [1, 2, 3]) m.state.firstSeen[s.tabMgr.get(t).cwd] = now - 10 * DAY;
    m._reapInactive(now);
    assert.deepEqual(s.tabMgr.closed, [1], 'stops once two tabs remain — a smaller fleet reads as a collapse to the restore watchdog');
});

test('refuses to judge on PTY silence alone when no transcripts can be read', () => {
    const s = fakeSession([{ id: 1, title: 'a', cwd: '/tmp/reap-test/a' }, { id: 2, title: 'b', cwd: '/tmp/reap-test/b' }, { id: 3, title: 'c', cwd: '/tmp/reap-test/c' }]);
    const m = newManager(s, { days: 1, transcripts: new Map() });
    const now = Date.now();
    for (const t of [1, 2, 3]) m.state.firstSeen[s.tabMgr.get(t).cwd] = now - 10 * DAY;
    m._reapInactive(now);
    assert.deepEqual(s.tabMgr.closed, [], 'an empty transcript map must fail closed');
});

test('runs at most once an hour and honours the day threshold', () => {
    const s = fakeSession([
        { id: 1, title: 'a', cwd: '/tmp/reap-test/a' },
        { id: 2, title: 'b', cwd: '/tmp/reap-test/b' },
        { id: 3, title: 'c', cwd: '/tmp/reap-test/c' },
        { id: 4, title: 'd', cwd: '/tmp/reap-test/d' },
    ]);
    const m = newManager(s, { days: 30 });
    const now = Date.now();
    m.state.firstSeen = { '/tmp/reap-test/a': now - 31 * DAY, '/tmp/reap-test/b': now - 29 * DAY, '/tmp/reap-test/c': now, '/tmp/reap-test/d': now };
    m._reapInactive(now);
    assert.deepEqual(s.tabMgr.closed, [1], '29 days silent is under a 30-day threshold');
    m.state.firstSeen['/tmp/reap-test/b'] = now - 40 * DAY;
    m._reapInactive(now + 10 * 60 * 1000);                      // 10 min later: throttled
    assert.deepEqual(s.tabMgr.closed, [1]);
    m._reapInactive(now + 61 * 60 * 1000);                      // an hour later: runs
    assert.deepEqual(s.tabMgr.closed, [1, 2]);
});

test('closeInactiveDays is clamped and defaults to 30', () => {
    const m = newManager(fakeSession([]));
    m.state.closeInactiveDays = 9999; m._saveState();
    const m2 = new SessionManager(fakeSession([])); clearInterval(m2._schedTimer);
    assert.equal(m2.state.closeInactiveDays, 365);
    m.state.closeInactiveDays = 'nope'; m._saveState();
    const m3 = new SessionManager(fakeSession([])); clearInterval(m3._schedTimer);
    assert.equal(m3.state.closeInactiveDays, 30);
});
