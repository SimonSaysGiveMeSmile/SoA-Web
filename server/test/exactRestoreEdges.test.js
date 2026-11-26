// Exact restore, the edges (review of 2026-11-25). The first pass made identity
// persist and the launch line exact; these pin the paths that could still hand
// a tab the wrong agent or a second tab's thread:
//   - the Time Machine payload ({cwd, title}, no identity, no rename flag);
//   - a saved thread that is live elsewhere, or lost to a duplicate;
//   - a bare shell / a tab on another thread swallowing a saved identity;
//   - a cwd guess being persisted as identity;
//   - the manager's continue/resume verbs on tabs that share a cwd;
//   - the observer keeping a dead process's id, and stale expectations.
//
// STATE_DIR is resolved at require() time, so it is pointed at a throwaway dir
// first; `node --test` runs each file in its own process.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = path.join(os.tmpdir(), `soa-web-exact-edges-test-${process.pid}`);
process.env.SOA_WEB_STATE_DIR = TMP;
process.env.SOA_WEB_TAB_SHRINK_GUARD_MS = '0';

const tabPersist = require('../src/tabPersist');
const sm = require('../src/sessionManager');
const fleetRestore = require('../src/fleetRestore');
const si = require('../src/sessionIdentity');

const A = 'fd99cf1d-e97c-4581-aba5-c3a9770fa320';
const B = '01a0dbf3-1b52-7500-bff7-d3d897e1e73b';
const C = '7b2c9e10-0d4f-4a51-9a3e-2f6c1d8e4b77';
const D = '4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8';

function reset() {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    tabPersist._resetForTest();
}
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function session(tabs) {
    const map = new Map();
    const order = [];
    tabs.forEach((t, i) => { const id = t.id || i + 1; order.push(id); map.set(id, { id, scrollback: { snapshot: () => '' }, userRenamed: false, ...t }); });
    return { tabMgr: { order, tabs: map, get: id => map.get(id) || null } };
}
function table(rows) {
    const procs = new Map(), kids = new Map();
    for (const [pid, ppid, cmd] of rows) {
        procs.set(pid, { ppid, cmd });
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push(pid);
    }
    return { procs, kids };
}
const recent = (pairs) => new Map(pairs.map(([cwd, ids]) => [cwd, ids.map((sessionId, i) => ({ sessionId, mtime: 1000 - i }))]));

// ── planRestore: identity first ───────────────────────────────────────────────

test('planRestore: a bare shell on the same cwd does not swallow a saved thread', () => {
    const saved = [{ cwd: '/h', agent: 'claude', sessionId: A }, { cwd: '/h', agent: 'claude', sessionId: B }];
    const p = tabPersist.planRestore(saved, [{ cwd: '/h', sessionId: null }]);
    assert.deepEqual(p.open.map(o => o.entry.sessionId), [A, B], 'both threads are opened');
});

test('planRestore: a live tab consumes the entry on ITS thread, not the first on its cwd', () => {
    const saved = [{ cwd: '/p', agent: 'claude', sessionId: A }, { cwd: '/p', agent: 'claude', sessionId: B }];
    const p = tabPersist.planRestore(saved, [{ cwd: '/p', sessionId: B }]);
    assert.deepEqual(p.open.map(o => o.entry.sessionId), [A]);
    assert.equal(p.skipped, 1);
});

test('planRestore: id-less entries still use the cwd multiset; legacy Map callers unchanged', () => {
    const saved = [{ cwd: '/p' }, { cwd: '/p' }, { cwd: '/p' }];
    assert.equal(tabPersist.planRestore(saved, [{ cwd: '/p', sessionId: C }]).open.length, 2);
    assert.equal(tabPersist.planRestore(saved, new Map([['/p', 2]])).open.length, 1);
    const ids = [{ cwd: '/q', agent: 'codex', sessionId: D }];
    assert.equal(tabPersist.planRestore(ids, new Map(), { elsewhere: new Set([D]) }).open.length, 0,
        'a thread live in another session is already open');
});

// ── allocate: a loser stays a shell ───────────────────────────────────────────

test('allocate: a saved id lost to a claim is NOT handed another thread', () => {
    const maps = { claude: recent([['/p', [A, C]]]), codex: new Map() };
    const e = [{ cwd: '/p', agent: 'claude', sessionId: A }];
    fleetRestore.allocate(e, { maps, claimed: new Set([A]) });
    assert.equal(e[0].sessionId, null, 'not C — nobody asked for C');
    assert.equal(e[0].lostId, true);
});

// ── restoreFleet: the Time Machine payload ────────────────────────────────────

function dirs() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-tm-'));
    const sp = path.join(root, 'proj');
    fs.mkdirSync(sp);
    return { root, sp };
}

test('restoreFleet: a {cwd,title} snapshot gets identity from tabs.json and no frozen auto titles', () => {
    reset();
    const { root, sp } = dirs();
    tabPersist.saveAll(session([
        { cwd: sp, agent: 'codex', sessionId: B, sessionCwd: sp },
        { cwd: sp, agent: 'codex', sessionId: D, sessionCwd: sp },
        { cwd: sp, agent: 'claude', sessionId: A, sessionCwd: path.join(sp, 'sub') },
    ]).tabMgr);
    // Exactly what web/public/assets/timemachine.js sends now — and what it
    // sent before (userRenamed: !!title), which must not freeze labels either.
    for (const flag of [undefined, true]) {
        const tabs = ['proj', 'proj-1', 'proj-2'].map(title => (flag ? { cwd: sp, title, userRenamed: flag } : { cwd: sp, title }));
        const out = fleetRestore.restoreFleet(session([]), { tabs, dryRun: true });
        assert.equal(out.from, 'request');
        assert.deepEqual(out.opened.map(o => [o.agent, o.sessionId, o.exact]), [['codex', B, true], ['codex', D, true], ['claude', A, true]]);
        assert.deepEqual(out.opened.map(o => [o.title, o.userRenamed]), [[null, false], [null, false], [null, false]]);
    }
    fs.rmSync(root, { recursive: true, force: true });
});

test('restoreFleet: a saved thread live in ANOTHER session is already open, not a duplicate shell', () => {
    reset();
    const { root, sp } = dirs();
    tabPersist.saveAll(session([
        { cwd: sp, agent: 'claude', sessionId: A },
        { cwd: sp, agent: 'claude', sessionId: C },
    ]).tabMgr);
    const elsewhere = session([{ cwd: sp, agent: 'claude', sessionId: A }]);
    const target = session([]);
    const out = fleetRestore.restoreFleet(target, { dryRun: true, sessions: [elsewhere, target] });
    assert.deepEqual(out.opened.map(o => o.sessionId), [C]);
    assert.equal(out.skipped.filter(s => s.why === 'already open').length, 1);
    fs.rmSync(root, { recursive: true, force: true });
});

test('userNamed: a persisted flag on an auto label is not believed (unfreezes old files)', () => {
    assert.equal(tabPersist.userNamed({ cwd: '/p/proj', title: 'proj-1', userRenamed: true }), false);
    assert.equal(tabPersist.userNamed({ cwd: '/p/proj', title: 'proj', userRenamed: true }), false);
    assert.equal(tabPersist.userNamed({ cwd: '/p/proj', title: 'deploy', userRenamed: true }), true);
    assert.equal(tabPersist.userNamed({ cwd: '/p/proj', title: 'deploy', userRenamed: false }), false);
});

// ── launchClaude: a guess is typed, never stamped ─────────────────────────────

function fakeTab(extra = {}) {
    const writes = [];
    return { writes, exited: false, write: s => writes.push(String(s)), ...extra };
}
const flush = async (tab) => { for (let i = 0; i < 10 && !tab.writes.length; i++) await new Promise(r => setImmediate(r)); };

test('launchClaude: an allocated (exact:false) id is resumed but not stamped as identity', async () => {
    const tab = fakeTab({ agent: 'claude' });
    sm.launchClaude(tab, '/p', { agent: 'claude', sessionId: C, sessionCwd: '/p', coldFallback: false, guess: false, exact: false });
    await flush(tab);
    assert.ok(tab.writes[0].includes(`claude --resume ${C}`));
    assert.equal(tab.sessionId, undefined, 'a guess is not identity');
    assert.equal(tab.agentObserved, true);
});

test('launchClaude: an exact id is stamped and marked as our launch', async () => {
    const tab = fakeTab({ agent: 'codex' });
    sm.launchClaude(tab, '/p', { agent: 'codex', sessionId: B, coldFallback: false, guess: false });
    await flush(tab);
    assert.equal(tab.sessionId, B);
    assert.equal(tab.sessionPid, 'launched');
});

// ── the manager's continue / resume verbs ─────────────────────────────────────

test('relaunchLines: tabs sharing a cwd never get the same thread, and never --continue/--last', () => {
    const t2 = { id: 2, cwd: '/p', agent: 'claude', sessionId: A, agentObserved: true };
    const t3 = { id: 3, cwd: '/p', agent: 'claude', agentObserved: true };
    const t4 = { id: 4, cwd: '/p', agent: 'claude', agentObserved: true };
    const t5 = { id: 5, cwd: '/q', agent: 'codex', agentObserved: true };
    const other = { id: 9, cwd: '/p', agent: 'claude', sessionId: C };   // live, not in the cohort
    // The SAME objects the manager holds: the cohort is excluded by identity.
    const live = [t2, t3, t4, t5, other];
    const all = [{ tabMgr: { order: live.map(t => t.id), tabs: new Map(live.map(t => [t.id, t])) } }];
    const maps = { claude: recent([['/p', [A, C, D]]]), codex: new Map() };
    const lines = sm.relaunchLines(null, [t2, t3, t4, t5], all, { maps });
    assert.equal(lines.get(t2), `claude --resume ${A}`, 'its own thread, exactly');
    assert.equal(lines.get(t3), `claude --resume ${D}`, 'the only unclaimed thread left');
    assert.equal(lines.has(t4), false, 'nothing left: no line, the tab stays a shell');
    assert.equal(lines.has(t5), false, 'a codex tab with no thread gets no line — and never a claude one');
    for (const l of lines.values()) assert.doesNotMatch(l, /--continue|--last/);
    assert.equal(t3.sessionId, undefined, 'the allocation is not stamped');
});

test('agentKindFor: an observed/launched kind outranks the painted guess', () => {
    const man = { tabs: new Map([[1, { agent: 'claude' }]]) };
    assert.equal(sm.agentKindFor(man, { id: 1, agent: 'codex', agentObserved: true }), 'codex');
    assert.equal(sm.agentKindFor(man, { id: 1, agent: 'codex' }), 'claude', 'unobserved: the paint still labels it');
});

// ── the observer ─────────────────────────────────────────────────────────────

test('stampTabs: a new same-kind process with no readable id clears the old id', () => {
    const tab = { pty: { pid: 100 }, agent: 'claude', sessionId: A, sessionPid: 101 };
    si.stampTabs([tab], { table: table([[100, 1, 'zsh'], [202, 100, 'claude']]) });
    assert.equal(tab.sessionId, null, 'pid 202 is not the process A was read off');
});

test('stampTabs: our own launch adopts the first process seen, keeping the typed id', () => {
    const tab = { pty: { pid: 100 }, agent: 'claude', sessionId: A, sessionPid: 'launched' };
    si.stampTabs([tab], { table: table([[100, 1, 'zsh'], [202, 100, 'claude']]) });
    assert.equal(tab.sessionId, A);
    assert.equal(tab.sessionPid, 202);
    si.stampTabs([tab], { table: table([[100, 1, 'zsh'], [202, 100, 'claude']]) });
    assert.equal(tab.sessionId, A, 'the same process on a later sweep keeps it');
});

test('cachedAgents: a registry answer expires', () => {
    const m = new Map([[1, { sessionId: A }]]);
    si._setCachedAgentsForTest(m, Date.now() - 11 * 60 * 1000);
    assert.equal(si.cachedAgents(), null);
    si._setCachedAgentsForTest(m);
    assert.equal(si.cachedAgents(), m);
    si._setCachedAgentsForTest(null, 0);
});

// ── expectations are judged once ─────────────────────────────────────────────

test('clearExpectations: the scheduled audit retires what it judged, not a newer restore', () => {
    const old = { restoreExpect: { agent: 'claude', sessionId: A, at: 1000 } };
    const newer = { restoreExpect: { agent: 'claude', sessionId: B, at: 5000 } };
    fleetRestore.clearExpectations([old, newer], 2000);
    assert.equal(old.restoreExpect, undefined);
    assert.ok(newer.restoreExpect);
});

test('auditTabs: a stale expectation is ignored in favour of the tab identity', () => {
    const tab = { id: 1, pty: { pid: 100 }, agent: 'claude', sessionId: C,
        restoreExpect: { agent: 'claude', sessionId: A, at: Date.now() - 60 * 60 * 1000 } };
    const a = si.auditTabs([tab], { table: table([[100, 1, 'zsh'], [101, 100, `claude --resume ${C}`]]) });
    assert.equal(a.tabs[0].status, 'ok');
});

test('auditSummary says when the claude registry was unavailable', () => {
    assert.match(si.auditSummary({ tabs: [], duplicates: [], counts: {}, registry: false }), /registry unavailable/);
});

// ── upgrade hints ────────────────────────────────────────────────────────────

test('applyHints: codex hints apply to codex tabs; a hint never flips a known agent', () => {
    reset();
    const entries = [{ cwd: '/p', agent: null }, { cwd: '/q', agent: 'claude' }];
    fs.writeFileSync(si.hintsPath(TMP), JSON.stringify({ savedAt: Date.now(), tabs: [
        { cwd: '/p', agent: 'codex', sessionId: B }, { cwd: '/q', agent: 'codex', sessionId: D },
    ] }));
    const r = si.applyHints(entries, TMP);
    assert.equal(r.applied, 1);
    assert.deepEqual([entries[0].agent, entries[0].sessionId], ['codex', B]);
    assert.equal(entries[1].sessionId, undefined);
});
