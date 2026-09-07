// Regression tests for the tabs.json clobber failure mode and its self-heal:
//   - a transient/pristine empty tab list must NEVER overwrite a good tabs.json
//   - a genuine user close-all MUST persist (and mark intent: closedByUser)
//   - reconcileTabsFromScrollback() rebuilds a lost tabs.json from scrollback
//   - ...but respects an intentional close-all and never resurrects it
//
// STATE_DIR is resolved at require() time from SOA_WEB_STATE_DIR, so it is set
// to a throwaway temp dir before requiring tabPersist. `node --test` runs each
// file in its own process, so this can't leak into other suites or real state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = path.join(os.tmpdir(), `soa-web-tabpersist-test-${process.pid}`);
process.env.SOA_WEB_STATE_DIR = TMP;
// These unit tests assert the INTENT-based guards (closedByUser, _liveTabsSeen,
// recoveredFrom, and the lastgood-preference in reconcile). Disable the separate
// TIME-based shrink boot-window guard (default 10 min) so a genuine close-all
// (shrink to 0) isn't refused simply because the test runs inside that window —
// the boot-window clobber guard is an integration concern, tested via uptime.
process.env.SOA_WEB_TAB_SHRINK_GUARD_MS = '0';

const tabPersist = require('../src/tabPersist');

// Minimal tabMgr stand-in: just what _writeMetaSync/_writeScrollbackSync read.
function mkMgr(tabs) {
    const map = new Map();
    const order = [];
    tabs.forEach((t, i) => {
        const id = i + 1;
        order.push(id);
        map.set(id, {
            cwd: t.cwd,
            title: t.title,
            userRenamed: !!t.userRenamed,
            scrollback: { snapshot: () => t.scrollback || '' },
        });
    });
    return { order, tabs: map };
}

function reset() {
    // Include the protected lastgood snapshot: reconcile now PREFERS it over
    // scrollback, so a lastgood left behind by an earlier test (any healthy ≥2-tab
    // save writes one) would leak into the next test's recovery. Also sweep the
    // rotating bak-* ring for the same reason.
    for (const f of [tabPersist.STATE_FILE, tabPersist.SCROLLBACK_FILE, tabPersist.SESSION_FILE,
                     tabPersist.STATE_FILE + '.lastgood']) {
        try { fs.rmSync(f); } catch (_) { /* absent */ }
    }
    try {
        for (const f of fs.readdirSync(path.dirname(tabPersist.STATE_FILE))) {
            if (f.startsWith(path.basename(tabPersist.STATE_FILE) + '.bak-')) {
                try { fs.rmSync(path.join(path.dirname(tabPersist.STATE_FILE), f)); } catch (_) {}
            }
        }
    } catch (_) { /* dir absent */ }
    tabPersist._resetLiveTabsSeen();
}

test('clobber guard: transient empty does NOT overwrite a good tabs.json', () => {
    reset();
    tabPersist.saveImmediate(mkMgr([{ cwd: '/a' }, { cwd: '/b' }]));
    assert.equal(tabPersist.load().tabs.length, 2);

    // Simulate a fresh process that never saw tabs (pristine boot / pre-restore),
    // then a stray empty save — the exact write that lost the fleet.
    tabPersist._resetLiveTabsSeen();
    tabPersist.saveImmediate(mkMgr([]));

    assert.equal(tabPersist.load().tabs.length, 2, 'good tabs.json must survive a transient empty write');
});

test('close-all: a real empty (after tabs seen) persists and is marked closedByUser', () => {
    reset();
    tabPersist.saveImmediate(mkMgr([{ cwd: '/a' }]));   // sets _liveTabsSeen
    tabPersist.saveImmediate(mkMgr([]));                 // genuine user close-all

    const saved = tabPersist.load();
    assert.equal(saved.tabs.length, 0);
    assert.equal(saved.closedByUser, true, 'intent marker must be recorded');
});

test('reconcile: rebuilds a lost tabs.json from scrollback.json', () => {
    reset();
    // Clobbered state: empty tabs.json (no marker) + intact scrollback.
    fs.writeFileSync(tabPersist.STATE_FILE, JSON.stringify({ savedAt: 'x', tabs: [] }));
    fs.writeFileSync(tabPersist.SCROLLBACK_FILE, JSON.stringify({
        savedAt: 'x',
        tabs: [
            { title: 'soa-web', cwd: '/proj/soa-web', scrollback: 'hello' },
            { title: 'custom-name', cwd: '/proj/api', scrollback: 'world' },
        ],
    }));
    tabPersist._resetLiveTabsSeen();

    const rec = tabPersist.reconcileTabsFromScrollback();
    assert.equal(rec.action, 'recovered');
    assert.equal(rec.count, 2);

    const saved = tabPersist.load();
    assert.deepEqual(saved.tabs.map(t => t.cwd), ['/proj/soa-web', '/proj/api']);
    // title == cwd basename → not a rename; title != basename → preserved rename
    assert.equal(saved.tabs[0].userRenamed, false);
    assert.equal(saved.tabs[1].userRenamed, true);
    assert.equal(saved.tabs[1].title, 'custom-name');
    assert.equal(saved.recoveredFrom, 'scrollback');
});

test('reconcile: respects an intentional close-all (no resurrection)', () => {
    reset();
    fs.writeFileSync(tabPersist.STATE_FILE, JSON.stringify({ savedAt: 'x', tabs: [], closedByUser: true }));
    fs.writeFileSync(tabPersist.SCROLLBACK_FILE, JSON.stringify({
        savedAt: 'x', tabs: [{ title: 'gone', cwd: '/proj/gone', scrollback: 'x' }],
    }));

    const rec = tabPersist.reconcileTabsFromScrollback();
    assert.equal(rec.action, 'noop');
    assert.equal(tabPersist.load().tabs.length, 0, 'must not resurrect a user-closed fleet');
});

test('reconcile: no-op when tabs.json is already intact', () => {
    reset();
    tabPersist.saveImmediate(mkMgr([{ cwd: '/a' }, { cwd: '/b' }, { cwd: '/c' }]));
    const rec = tabPersist.reconcileTabsFromScrollback();
    assert.equal(rec.action, 'noop');
    assert.equal(tabPersist.load().tabs.length, 3);
});

test('scrollback clobber guard: transient empty does NOT overwrite a good scrollback.json', () => {
    reset();
    // saveAll writes BOTH tabs.json and scrollback.json.
    tabPersist.saveAll(mkMgr([{ cwd: '/a', scrollback: 'AAA' }, { cwd: '/b', scrollback: 'BBB' }]));
    assert.equal(tabPersist.loadScrollback().tabs.length, 2);

    // Fresh process that never saw tabs, then a stray empty saveAll — this is the
    // write that could orphan scrollback.json (the self-heal recovery SOURCE).
    tabPersist._resetLiveTabsSeen();
    tabPersist.saveAll(mkMgr([]));

    assert.equal(tabPersist.loadScrollback().tabs.length, 2,
        'good scrollback.json must survive a transient empty write (recovery source protected)');
});

test('scrollback close-all: a real empty (after tabs seen) DOES persist empty scrollback', () => {
    reset();
    tabPersist.saveAll(mkMgr([{ cwd: '/a', scrollback: 'AAA' }]));  // sets _liveTabsSeen
    tabPersist.saveAll(mkMgr([]));                                   // genuine close-all

    assert.equal(tabPersist.loadScrollback().tabs.length, 0,
        'a genuine close-all (tabs seen this process) must write the empty scrollback');
});

test('post-recovery: a transient empty must NOT clobber or tombstone a scrollback-recovered tabs.json', () => {
    reset();
    // Clobbered-then-recovered state.
    fs.writeFileSync(tabPersist.STATE_FILE, JSON.stringify({ savedAt: 'x', tabs: [] }));
    fs.writeFileSync(tabPersist.SCROLLBACK_FILE, JSON.stringify({
        savedAt: 'x', tabs: [
            { title: 'soa-web', cwd: '/proj/soa-web', scrollback: 'hi' },
            { title: 'api', cwd: '/proj/api', scrollback: 'yo' },
        ],
    }));
    tabPersist._resetLiveTabsSeen();
    const rec = tabPersist.reconcileTabsFromScrollback();
    assert.equal(rec.action, 'recovered');

    // A transient empty save right after recovery (e.g. a probe/second session,
    // before any real tab re-persists) must neither clobber the recovered list
    // nor mark it closedByUser — otherwise the NEXT boot refuses to self-heal.
    tabPersist.saveImmediate(mkMgr([]));

    const saved = tabPersist.load();
    assert.equal(saved.tabs.length, 2, 'recovered tabs.json must survive a transient empty post-recovery');
    assert.notEqual(saved.closedByUser, true, 'recovered fleet must NOT be tombstoned by a transient empty');
    assert.equal(saved.recoveredFrom, 'scrollback', 'recovery marker preserved');

    // And the next boot still recovers (no spurious closedByUser intent).
    const rec2 = tabPersist.reconcileTabsFromScrollback();
    assert.equal(rec2.action, 'noop');
    assert.equal(rec2.reason, 'tabs.json intact');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

// ── restore-on-connect planning: fleet-wide "already live" accounting ─────────
// 2026-08-25: the live multiset was counted for the CONNECTING session only, so
// a phone binding to a fresh empty session re-opened (and `claude --resume`d)
// every tab of the fleet already running in the desktop's session.
function mkSession(tabs) {
    const map = new Map();
    tabs.forEach((t, i) => map.set(i + 1, { cwd: t.cwd, exited: !!t.exited }));
    return { tabMgr: { order: [...map.keys()], tabs: map } };
}

test('liveCwdCounts: counts live tabs across every session, skipping exited shells', () => {
    const counts = tabPersist.liveCwdCounts([
        mkSession([{ cwd: '/a' }, { cwd: '/b' }]),
        mkSession([{ cwd: '/a' }, { cwd: '/c', exited: true }]),
        { tabMgr: null },
        null,
    ]);
    assert.deepEqual([...counts.entries()].sort(), [['/a', 2], ['/b', 1]]);
});

test('planRestore: a live tab anywhere consumes one saved entry; extras still open', () => {
    const saved = [{ cwd: '/a' }, { cwd: '/a' }, { cwd: '/a' }, { cwd: '/b' }, { cwd: '/d' }];
    const live = new Map([['/a', 2], ['/b', 1]]);
    const plan = tabPersist.planRestore(saved, live);
    assert.equal(plan.skipped, 3);
    assert.deepEqual(plan.open.map(o => [o.index, o.entry.cwd]), [[2, '/a'], [4, '/d']]);
    assert.equal(live.get('/a'), 2, 'input multiset is not mutated');
});

test('planRestore: nothing live → everything opens, keeping saved indexes for scrollback pairing', () => {
    const plan = tabPersist.planRestore([{ cwd: '/x' }, { cwd: '/y' }], new Map());
    assert.equal(plan.skipped, 0);
    assert.deepEqual(plan.open.map(o => o.index), [0, 1]);
});

test('planRestore: fully-live fleet → opens nothing (no duplicate agents)', () => {
    const plan = tabPersist.planRestore([{ cwd: '/x' }, { cwd: '/y' }], new Map([['/x', 1], ['/y', 3]]));
    assert.equal(plan.open.length, 0);
    assert.equal(plan.skipped, 2);
});
