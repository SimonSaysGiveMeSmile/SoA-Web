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
    for (const f of [tabPersist.STATE_FILE, tabPersist.SCROLLBACK_FILE, tabPersist.SESSION_FILE]) {
        try { fs.rmSync(f); } catch (_) { /* absent */ }
    }
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

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });
