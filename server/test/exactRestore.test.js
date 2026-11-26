// Exact agent + session restore (2026-11-25). After a restart the fleet came
// back with the right tabs but the wrong workers: Codex tabs relaunched as
// Claude, one conversation resumed into ten tabs, and `|| claude --continue` /
// `|| codex resume --last` quietly attaching another tab's thread. These pin:
//   - identity (agent, sessionId, sessionCwd) survives every persisted copy
//     and every reconcile;
//   - the launch line resumes an id EXACTLY, from the thread's own directory,
//     with nothing behind it but a cold start of the SAME agent;
//   - the allocator never hands one thread to two tabs;
//   - restore never marks a title the user did not choose as a rename;
//   - the audit reports wrong agent / wrong thread / duplicates.
//
// STATE_DIR is resolved at require() time, so it is pointed at a throwaway dir
// first; `node --test` runs each file in its own process.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = path.join(os.tmpdir(), `soa-web-exact-restore-test-${process.pid}`);
process.env.SOA_WEB_STATE_DIR = TMP;
process.env.SOA_WEB_TAB_SHRINK_GUARD_MS = '0';

const tabPersist = require('../src/tabPersist');
const sm = require('../src/sessionManager');
const fleetRestore = require('../src/fleetRestore');
const si = require('../src/sessionIdentity');
const { Tab } = require('../src/tabManager');

const A = 'fd99cf1d-e97c-4581-aba5-c3a9770fa320';
const B = '01a0dbf3-1b52-7500-bff7-d3d897e1e73b';
const C = '7b2c9e10-0d4f-4a51-9a3e-2f6c1d8e4b77';
const D = '4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8';

function mkMgr(tabs) {
    const map = new Map();
    const order = [];
    tabs.forEach((t, i) => {
        const id = i + 1;
        order.push(id);
        map.set(id, { id, scrollback: { snapshot: () => t.scrollback || '' }, userRenamed: false, ...t });
    });
    return { order, tabs: map };
}

function reset() {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    tabPersist._resetForTest();
}

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ── 1. persistence ───────────────────────────────────────────────────────────

const FLEET = [
    { cwd: '/p/side', agent: 'claude', sessionId: A, sessionCwd: '/p/side/pisnp' },
    { cwd: '/p/side', agent: 'codex', sessionId: B, sessionCwd: '/p/side' },
    { cwd: '/p/api', agent: null, sessionId: null, sessionCwd: null },
];
const ident = t => ({ agent: t.agent, sessionId: t.sessionId, sessionCwd: t.sessionCwd });

test('identity round-trips through tabs.json, lastgood and scrollback.json', () => {
    reset();
    tabPersist.saveAll(mkMgr(FLEET));
    assert.deepEqual(tabPersist.load().tabs.map(ident), FLEET.map(ident));
    assert.deepEqual(tabPersist.loadLastGood().tabs.map(ident), FLEET.map(ident), 'lastgood carries it');
    const sb = tabPersist.loadScrollback().tabs;
    assert.deepEqual(sb.map(ident), FLEET.map(ident), 'scrollback.json meta carries it');
    assert.deepEqual(sb.map(t => t.userRenamed), [false, false, false]);
    const bak = fs.readdirSync(TMP).find(f => f.startsWith('tabs.json.bak-'));
    assert.ok(bak, 'a bak-* snapshot was rotated');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(TMP, bak), 'utf8')).tabs.map(ident), FLEET.map(ident));
});

test('reconcile from lastgood keeps agent / sessionId / sessionCwd', () => {
    reset();
    tabPersist.saveAll(mkMgr(FLEET));
    // Collapse tabs.json to a lone default tab: the loss signature.
    fs.writeFileSync(tabPersist.STATE_FILE, JSON.stringify({ savedAt: new Date().toISOString(), tabs: [{ cwd: '/p/api' }] }));
    const r = tabPersist.reconcileTabsFromScrollback();
    assert.equal(r.action, 'recovered');
    assert.equal(r.from, 'lastgood');
    assert.deepEqual(tabPersist.load().tabs.map(ident), FLEET.map(ident));
});

test('reconcile from scrollback (no lastgood) keeps identity too', () => {
    reset();
    tabPersist.saveAll(mkMgr(FLEET));
    fs.rmSync(path.join(TMP, 'tabs.json.lastgood'));
    fs.rmSync(tabPersist.STATE_FILE);
    const r = tabPersist.reconcileTabsFromScrollback();
    assert.equal(r.from, 'scrollback');
    assert.deepEqual(tabPersist.load().tabs.map(ident), FLEET.map(ident));
});

test('identityOf: an id is only identity when we know whose it is', () => {
    assert.deepEqual(tabPersist.identityOf({ sessionId: A, sessionCwd: '/x' }), { agent: null, sessionId: null, sessionCwd: null });
    assert.deepEqual(tabPersist.identityOf({ agent: 'gemini', sessionId: A }), { agent: null, sessionId: null, sessionCwd: null });
    assert.equal(tabPersist.identityOf({ agent: 'claude', sessionId: "x'; rm -rf ~" }).sessionId, null, 'unsafe ids are dropped');
    assert.equal(tabPersist.identityOf({ agent: 'claude', sessionId: A, sessionCwd: 'rel/dir' }).sessionCwd, null);
});

test('fleetRestore.pickSource keeps identity from every source', () => {
    reset();
    tabPersist.saveAll(mkMgr(FLEET));
    const src = fleetRestore.pickSource();
    assert.equal(src.from, 'tabs.json');
    assert.deepEqual(src.tabs.map(ident), FLEET.map(ident));
    fs.rmSync(tabPersist.STATE_FILE);
    fs.rmSync(path.join(TMP, 'tabs.json.lastgood'));
    for (const f of fs.readdirSync(TMP)) if (f.startsWith('tabs.json.bak-')) fs.rmSync(path.join(TMP, f));
    const sb = fleetRestore.pickSource();
    assert.equal(sb.from, 'scrollback');
    assert.deepEqual(sb.tabs.map(ident), FLEET.map(ident));
});

// ── 2. the launch line ───────────────────────────────────────────────────────

test('an exact id is resumed with no --continue / --last behind it', () => {
    for (const cold of [false, true]) {
        const c = sm.agentLaunchLine('claude', { sessionId: A, coldFallback: cold });
        const x = sm.agentLaunchLine('codex', { sessionId: B, coldFallback: cold });
        assert.match(c, new RegExp(`claude --resume ${A}`));
        assert.match(x, new RegExp(`codex resume ${B} -c check_for_update_on_startup=false`));
        for (const l of [c, x]) assert.doesNotMatch(l, /--continue|--last/);
        if (cold) {
            assert.match(c, /\|\| claude$/, 'cold fallback is the SAME agent, fresh');
            assert.match(x, /\|\| codex -c check_for_update_on_startup=false$/);
        } else {
            assert.doesNotMatch(c + x, /\|\|/, 'no fallback at all for a restore');
        }
    }
});

test('a codex line never contains claude, and vice versa', () => {
    const variants = [{}, { sessionId: A }, { sessionId: A, coldFallback: true }, { resume: false }, { coldFallback: true }];
    for (const v of variants) {
        assert.doesNotMatch(sm.agentLaunchLine('codex', v), /claude/);
        assert.doesNotMatch(sm.agentLaunchLine('claude', v), /codex/);
    }
});

test('a thread from another directory resumes in a subshell from there, safely quoted', () => {
    const l = sm.agentLaunchLine('claude', { sessionId: A, sessionCwd: '/p/side/pisnp', cwd: '/p/side' });
    assert.equal(l, `(cd '/p/side/pisnp' && claude --resume ${A})`);
    assert.equal(sm.agentLaunchLine('claude', { sessionId: A, sessionCwd: '/p/side', cwd: '/p/side' }), `claude --resume ${A}`,
        'same directory: no subshell');
    const evil = sm.agentLaunchLine('codex', { sessionId: B, sessionCwd: "/p/it's $(rm -rf ~)", cwd: '/p' });
    assert.ok(evil.startsWith(`(cd '/p/it'\\''s $(rm -rf ~)' && codex resume ${B}`), evil);
    assert.equal(sm.shellQuote("a'b"), `'a'\\''b'`);
});

test('unsafe ids and models are never interpolated', () => {
    const l = sm.agentLaunchLine('claude', { sessionId: 'x; rm -rf ~', model: 'opus; curl evil' });
    assert.doesNotMatch(l, /rm -rf|curl/);
});

test('resumeLineFor: the tab\'s own id wins, and a cwd hit carries no --last', () => {
    const maps = { claude: new Map([['/p', { sessionId: C }]]), codex: new Map([['/p', { sessionId: D }]]) };
    assert.equal(sm.resumeLineFor('claude', '/p', { maps, sessionId: A }), `claude --resume ${A}`);
    assert.equal(sm.resumeLineFor('claude', '/p', { maps }), `claude --resume ${C}`);
    assert.doesNotMatch(sm.resumeLineFor('codex', '/p', { maps }), /--last|claude/);
});

function fakeTab(extra = {}) {
    const writes = [];
    return { writes, exited: false, write: s => writes.push(String(s)), ...extra };
}
const flush = async (tab) => { for (let i = 0; i < 10 && !tab.writes.length; i++) await new Promise(r => setImmediate(r)); };

test('launchClaude: exact restore launches that agent on that id and stamps the tab', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-home-'));
    const tab = fakeTab({ agent: 'codex', cwd: '/nowhere' });
    const sid = sm.launchClaude(tab, '/nowhere', { agent: 'codex', sessionId: B, sessionCwd: home, coldFallback: false, guess: false });
    await flush(tab);
    assert.equal(sid, B);
    assert.ok(tab.writes[0].includes(`(cd '${home}' && codex resume ${B} -c check_for_update_on_startup=false)`), tab.writes[0]);
    assert.doesNotMatch(tab.writes[0], /claude|--last/);
    assert.deepEqual([tab.agent, tab.sessionId, tab.sessionCwd], ['codex', B, home]);
    fs.rmSync(home, { recursive: true, force: true });
});

test('launchClaude: a sessionCwd that no longer exists runs from the tab cwd', async () => {
    const tab = fakeTab({ agent: 'claude' });
    sm.launchClaude(tab, '/p', { sessionId: A, sessionCwd: '/definitely/not/here', coldFallback: false, guess: false });
    await flush(tab);
    assert.ok(tab.writes[0].includes(`; claude --resume ${A}; `), tab.writes[0]);
});

test('launchClaude: guess:false with no id cold-starts nothing borrowed', async () => {
    const tab = fakeTab({ agent: 'codex' });
    assert.equal(sm.launchClaude(tab, '/p', { coldFallback: false, guess: false }), null);
    await flush(tab);
    assert.doesNotMatch(tab.writes[0], /resume|--last|claude/);
});

// ── 3. the allocator ─────────────────────────────────────────────────────────

const recent = (pairs) => new Map(pairs.map(([cwd, ids, mt = 1000]) => [cwd, ids.map((sessionId, i) => ({ sessionId, mtime: mt - i }))]));

test('allocate: a saved id is kept exactly; a duplicate is resumed only once', () => {
    const entries = [
        { cwd: '/p', agent: 'claude', sessionId: A },
        { cwd: '/p', agent: 'claude', sessionId: A },   // a bad earlier restore wrote it twice
        { cwd: '/q', agent: 'codex', sessionId: B },
    ];
    fleetRestore.allocate(entries);
    assert.deepEqual(entries.map(e => [e.sessionId, e.exact]), [[A, true], [null, false], [B, true]]);
    assert.equal(entries[1].agent, 'claude', 'the loser keeps its agent');
});

test('allocate: id-less tabs get distinct, unclaimed threads; never one id twice', () => {
    const maps = { claude: recent([['/p', [A, C, D]]]), codex: recent([['/q', [B]]]) };
    const entries = [
        { cwd: '/p', agent: 'claude', sessionId: C },   // saved identity, claims C
        { cwd: '/p', agent: 'claude' },
        { cwd: '/p', agent: 'claude' },
        { cwd: '/p', agent: 'claude' },                 // nothing left
        { cwd: '/q', agent: null },                     // unknown → codex is the only thread
    ];
    fleetRestore.allocate(entries, { maps, claimed: new Set([A]) });   // A is live in another tab
    assert.deepEqual(entries.map(e => e.sessionId), [C, D, null, null, B]);
    assert.deepEqual(entries.map(e => e.exact), [true, false, false, false, false]);
    assert.equal(entries[4].agent, 'codex');
    const ids = entries.map(e => e.sessionId).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, 'one id, one tab');
});

test('allocate: a saved id claimed by a live tab is not resumed again', () => {
    const entries = [{ cwd: '/p', agent: 'claude', sessionId: A }];
    fleetRestore.allocate(entries, { maps: { claude: recent([['/p', [A]]]), codex: new Map() }, claimed: new Set([A]) });
    assert.equal(entries[0].sessionId, null);
});

test('claimedIds: live ids across sessions, minus the tabs being restored', () => {
    const t1 = { sessionId: A }, t2 = { sessionId: B }, t3 = { sessionId: C, exited: true };
    const s = { tabMgr: { order: [1, 2, 3], tabs: new Map([[1, t1], [2, t2], [3, t3]]) } };
    assert.deepEqual([...fleetRestore.claimedIds([s])].sort(), [A, B].sort());
    assert.deepEqual([...fleetRestore.claimedIds([s], new Set([t2]))], [A]);
});

// ── 4. userRenamed ───────────────────────────────────────────────────────────

test('a title set by restore is not a user rename', () => {
    assert.equal(new Tab({ cwd: '/p/Side-Proj', title: 'Side-Proj-1', userRenamed: false }).userRenamed, false);
    assert.equal(new Tab({ cwd: '/p/Side-Proj', title: 'My name', userRenamed: true }).userRenamed, true);
    assert.equal(new Tab({ cwd: '/p/Side-Proj', title: 'Spawned' }).userRenamed, true, 'legacy callers unchanged');
});

test('legacy scrollback: dedupe labels and basenames are not renames', () => {
    const r = tabPersist.renamedFromScrollback;
    assert.equal(r({ cwd: '/p/Side-Proj', title: 'Side-Proj' }), false);
    assert.equal(r({ cwd: '/p/Side-Proj', title: 'Side-Proj-2' }), false);
    assert.equal(r({ cwd: '/p/Side-Proj', title: 'deploy box' }), true);
    assert.equal(r({ cwd: '/p/Side-Proj', title: 'deploy box', userRenamed: false }), false, 'a recorded flag wins');
});

test('pickSource: an explicit list with titles but no rename flag does not freeze names', () => {
    const src = fleetRestore.pickSource([{ cwd: '/p/a', title: 'a-1' }, { cwd: '/p/b', title: 'Mine', userRenamed: true }]);
    assert.deepEqual(src.tabs.map(t => [t.title, t.userRenamed]), [[null, false], ['Mine', true]]);
});

// ── 5. the audit ─────────────────────────────────────────────────────────────

function table(rows) {
    const procs = new Map(), kids = new Map();
    for (const [pid, ppid, cmd] of rows) {
        procs.set(pid, { ppid, cmd });
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push(pid);
    }
    return { procs, kids };
}

const AUDIT_ROWS = [
    [100, 1, '/bin/zsh'], [101, 100, `claude --resume ${A}`],            // ok
    [200, 1, '/bin/zsh'], [201, 200, `claude --resume ${A}`],            // codex expected, claude running — and a duplicate of A
    [300, 1, '/bin/zsh'], [301, 300, `codex resume ${C}`],               // wrong thread
    [400, 1, '/bin/zsh'],                                                // resume failed → shell
    [500, 1, '/bin/zsh'], [501, 500, 'claude'],                          // bare title, no registry
];
const auditTabsFixture = () => [
    { id: 1, pty: { pid: 100 }, restoreExpect: { agent: 'claude', sessionId: A } },
    { id: 2, pty: { pid: 200 }, restoreExpect: { agent: 'codex', sessionId: B } },
    { id: 3, pty: { pid: 300 }, restoreExpect: { agent: 'codex', sessionId: D } },
    { id: 4, pty: { pid: 400 }, restoreExpect: { agent: 'claude', sessionId: C } },
    { id: 5, pty: { pid: 500 }, agent: 'claude', sessionId: D },
];

test('audit: expected vs observed per tab, and duplicate detection', () => {
    const a = si.auditTabs(auditTabsFixture(), { table: table(AUDIT_ROWS) });
    assert.deepEqual(a.tabs.map(r => r.status), ['ok', 'wrong-agent', 'wrong-session', 'missing', 'unverified']);
    assert.deepEqual(a.duplicates, [{ sessionId: A, tabs: [1, 2] }]);
    assert.deepEqual(a.tabs[2].observed, { agent: 'codex', sessionId: C });
    assert.match(si.auditSummary(a), /^5 tab\(s\) · .*1 ok.* · 1 duplicate id\(s\)$/);
});

test('audit: the registry turns a bare claude into a verified one', () => {
    const reg = new Map([[501, { sessionId: D }]]);
    const a = si.auditTabs(auditTabsFixture(), { table: table(AUDIT_ROWS), agents: reg });
    assert.equal(a.tabs[4].status, 'ok');
});

test('auditFleet sweeps after comparing, so restoreExpect — not the stamp — is judged', () => {
    const tabs = auditTabsFixture();
    const s = { tabMgr: { order: tabs.map(t => t.id), tabs: new Map(tabs.map(t => [t.id, t])) } };
    const a = fleetRestore.auditFleet([s], { table: table(AUDIT_ROWS), persist: false });
    assert.equal(a.tabs[1].status, 'wrong-agent');
    assert.equal(tabs[1].agent, 'claude', 'the sweep then records what is really running');
    assert.equal(tabs[2].sessionId, C);
    // A second audit still judges against what the restore meant.
    assert.equal(fleetRestore.auditFleet([s], { table: table(AUDIT_ROWS), persist: false }).tabs[2].status, 'wrong-session');
});
