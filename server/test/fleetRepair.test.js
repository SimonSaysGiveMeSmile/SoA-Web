// The standard restart (2026-11-25, made routine): soa-restart snapshots each
// tab's identity into session-hints.json, restarts through the supervisor,
// waits for the restore's audit, and POST /api/fleet/repair puts any tab on
// the wrong agent or thread back exactly. These pin:
//   - the repair planner: only exact expectations, never ok/unverified/shell,
//     the manager or the caller; the duplicate rule; the exact launch line;
//   - the kill-until-shell loop (SIGTERM, then SIGKILL; a fallback agent that
//     starts is stopped too);
//   - repairFleet's wiring (Ctrl-U, then the line, then a re-audit);
//   - the hints writer, the newer-list rule, and the old-daemon ps mapper;
//   - the CLI end to end against a stub daemon, with SOA_RESTART_DRY=1 (exit
//     codes, the hint file, no launchctl).
//
// STATE_DIR is resolved at require() time, so it is pointed at a throwaway dir
// first; `node --test` runs each file in its own process.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');

const TMP = path.join(os.tmpdir(), `soa-web-fleet-repair-test-${process.pid}`);
process.env.SOA_WEB_STATE_DIR = TMP;
process.env.SOA_WEB_TAB_SHRINK_GUARD_MS = '0';
process.env.SOA_WEB_CLAUDE_AGENTS = '0';   // never ask this machine's registry

const fleetRestore = require('../src/fleetRestore');
const si = require('../src/sessionIdentity');
const cli = require('../../scripts/soa-restart');

const CLI = path.join(__dirname, '..', '..', 'scripts', 'soa-restart');
const A = 'fd99cf1d-e97c-4581-aba5-c3a9770fa320';
const B = '01a0dbf3-1b52-7500-bff7-d3d897e1e73b';
const C = '7b2c9e10-0d4f-4a51-9a3e-2f6c1d8e4b77';
const D = '4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8';

fs.mkdirSync(TMP, { recursive: true });
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function table(rows) {
    const procs = new Map(), kids = new Map();
    for (const [pid, ppid, cmd] of rows) {
        procs.set(pid, { ppid, cmd });
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push(pid);
    }
    return { procs, kids };
}
const exact = (agent, sessionId, extra = {}) => ({ agent, sessionId, exact: true, at: Date.now(), ...extra });
const row = (id, status, expected, observed) => ({ id, status, cwd: '/p', expected, observed });
const plan = (pairs, o = {}) => fleetRestore.planRepair(pairs, { resolveCwd: () => null, exists: () => true, ...o });

// ── the planner ───────────────────────────────────────────────────────────────

test('planRepair: repairs exact expectations only, with the exact launch line', () => {
    const pairs = [
        { tab: { id: 1, cwd: '/p', restoreExpect: exact('claude', A) },
            row: row(1, 'wrong-session', { agent: 'claude', sessionId: A }, { agent: 'claude', sessionId: B }) },
        { tab: { id: 2, cwd: '/p', restoreExpect: exact('codex', C, { sessionCwd: '/p/sub' }) },
            row: row(2, 'wrong-agent', { agent: 'codex', sessionId: C }, { agent: 'claude', sessionId: null }) },
        { tab: { id: 3, cwd: '/p', restoreExpect: { agent: 'claude', sessionId: D, exact: false, at: Date.now() } },
            row: row(3, 'wrong-session', { agent: 'claude', sessionId: D }, { agent: 'claude', sessionId: null }) },
        { tab: { id: 4, cwd: '/p' }, row: row(4, 'ok', { agent: 'claude', sessionId: null }, { agent: 'claude', sessionId: null }) },
        { tab: { id: 5, cwd: '/p', restoreExpect: exact('claude', D) },
            row: row(5, 'unverified', { agent: 'claude', sessionId: D }, { agent: 'claude', sessionId: null }) },
        { tab: { id: 6, cwd: '/p' }, row: row(6, 'shell', { agent: null, sessionId: null }, null) },
    ];
    const { plan: p, left } = plan(pairs);
    assert.deepEqual(p.map(x => x.id), [1, 2]);
    assert.equal(p[0].line, `claude --resume ${A}`);
    assert.equal(p[1].line, `(cd '/p/sub' && codex resume ${C} -c check_for_update_on_startup=false)`);
    assert.ok(!p.some(x => /--continue|--last|\|\|/.test(x.line)));
    assert.deepEqual(left.map(l => [l.id, l.why]), [[3, 'no exact expected identity']]);
});

test('planRepair: never the manager tab or the caller; ids narrow the set', () => {
    const mk = (id, title) => ({ tab: { id, title, cwd: '/p', restoreExpect: exact('claude', [A, B, C][id - 1]) },
        row: row(id, 'wrong-session', { agent: 'claude', sessionId: [A, B, C][id - 1] }, { agent: 'claude', sessionId: D }) });
    const pairs = [mk(1, ' Manager '), mk(2, 'api'), mk(3, 'web')];
    const r = plan(pairs, { selfId: 2 });
    assert.deepEqual(r.plan.map(x => x.id), [3]);
    assert.deepEqual(r.left.map(l => [l.id, l.why]), [[1, 'manager tab'], [2, 'caller tab']]);
    assert.deepEqual(plan(pairs, { ids: [3] }).plan.map(x => x.id), [3]);
    assert.deepEqual(plan(pairs, { ids: [2] }).plan.map(x => x.id), [2]);
});

test('planRepair: a tab identity counts for a failed resume (missing), not for a live switch', () => {
    const pairs = [
        { tab: { id: 1, cwd: '/p', agent: 'codex', sessionId: C, sessionCwd: '/p' },
            row: row(1, 'missing', { agent: 'codex', sessionId: C }, null) },
        { tab: { id: 2, cwd: '/p', agent: 'claude', sessionId: B },   // the sweep already adopted B
            row: row(2, 'wrong-session', { agent: 'claude', sessionId: A }, { agent: 'claude', sessionId: B }) },
    ];
    const r = plan(pairs);
    assert.deepEqual(r.plan.map(x => [x.id, x.line]), [[1, `codex resume ${C} -c check_for_update_on_startup=false`]]);
    assert.deepEqual(r.left.map(l => l.id), [2]);
});

test('planRepair: a thread on two tabs — the owner keeps it, an exact other is repaired, the rest is reported', () => {
    const pairs = [
        { tab: { id: 1, cwd: '/p', agent: 'claude', sessionId: A }, row: row(1, 'ok', { agent: 'claude', sessionId: A }, { agent: 'claude', sessionId: A }) },
        { tab: { id: 2, cwd: '/p', restoreExpect: exact('claude', B) }, row: row(2, 'wrong-session', { agent: 'claude', sessionId: B }, { agent: 'claude', sessionId: A }) },
        { tab: { id: 3, cwd: '/p', agent: 'claude' }, row: row(3, 'ok', { agent: 'claude', sessionId: null }, { agent: 'claude', sessionId: A }) },
    ];
    const r = plan(pairs, { duplicates: [{ sessionId: A, tabs: [1, 2, 3] }] });
    assert.deepEqual(r.plan.map(x => x.id), [2]);
    assert.equal(r.left.length, 1);
    assert.equal(r.left[0].id, 3);
    assert.equal(r.left[0].action, 'left');
    assert.match(r.left[0].why, /no exact id of its own/);
});

test('planRepair: never resumes a thread that stays live in another tab, or one two tabs expect', () => {
    const pairs = [
        { tab: { id: 1, cwd: '/p', agent: 'claude', sessionId: A }, row: row(1, 'ok', { agent: 'claude', sessionId: A }, { agent: 'claude', sessionId: A }) },
        { tab: { id: 2, cwd: '/p', restoreExpect: exact('claude', A) }, row: row(2, 'missing', { agent: 'claude', sessionId: A }, null) },
        { tab: { id: 3, cwd: '/p', restoreExpect: exact('claude', C) }, row: row(3, 'missing', { agent: 'claude', sessionId: C }, null) },
        { tab: { id: 4, cwd: '/p', restoreExpect: exact('claude', C) }, row: row(4, 'missing', { agent: 'claude', sessionId: C }, null) },
    ];
    const r = plan(pairs);
    assert.deepEqual(r.plan.map(x => x.id), [3]);
    assert.deepEqual(r.left.map(l => l.id), [2, 4]);
    assert.match(r.left[0].why, /live in tab #1/);
});

test('planRepair: a swap — a thread moving off a tab being repaired is free: both are planned', () => {
    // #1 should be on A but runs B; #2 should be on B but runs A.
    const pairs = [
        { tab: { id: 1, cwd: '/p', restoreExpect: exact('claude', A) }, row: row(1, 'wrong-session', { agent: 'claude', sessionId: A }, { agent: 'claude', sessionId: B }) },
        { tab: { id: 2, cwd: '/p', restoreExpect: exact('claude', B) }, row: row(2, 'wrong-session', { agent: 'claude', sessionId: B }, { agent: 'claude', sessionId: A }) },
    ];
    assert.deepEqual(plan(pairs).plan.map(x => x.id).sort(), [1, 2]);
});

test('clearExpectations keeps a broken exact expectation for the repair', () => {
    const broken = { id: 1, restoreExpect: exact('claude', A, { at: 1000 }) };
    const fine = { id: 2, restoreExpect: exact('claude', B, { at: 1000 }) };
    const guessed = { id: 3, restoreExpect: { agent: 'claude', sessionId: C, exact: false, at: 1000 } };
    fleetRestore.clearExpectations([broken, fine, guessed], 2000,
        { tabs: [{ id: 1, status: 'wrong-session' }, { id: 2, status: 'ok' }, { id: 3, status: 'wrong-session' }] });
    assert.ok(broken.restoreExpect);
    assert.equal(fine.restoreExpect, undefined);
    assert.equal(guessed.restoreExpect, undefined);
});

// ── kill until only the shell is left ─────────────────────────────────────────

test('stopAgent: SIGTERMs the agent, then the fallback that starts, until only the shell is left', async () => {
    const tables = [
        table([[100, 1, '-zsh'], [101, 100, `claude --resume ${A}`]]),
        table([[100, 1, '-zsh'], [102, 100, 'claude']]),             // `|| claude` started
        table([[100, 1, '-zsh']]),
    ];
    const kills = [];
    let slept = 0;
    const r = await fleetRestore.stopAgent(100, {
        table: async () => tables.shift(), kill: (pid, sig) => kills.push([pid, sig]), sleep: async (ms) => { slept += ms; },
        intervalMs: 2000,
    });
    assert.equal(r.ok, true);
    assert.deepEqual(kills, [[101, 'SIGTERM'], [102, 'SIGTERM']]);
    assert.equal(slept, 4000);
});

test('stopAgent: escalates to SIGKILL after six tries, gives up after the budget, never signals the shell', async () => {
    const stuck = table([[100, 1, '-zsh'], [101, 100, 'codex resume ' + C]]);
    const kills = [];
    const r = await fleetRestore.stopAgent(100, {
        table: async () => stuck, kill: (pid, sig) => kills.push([pid, sig]), sleep: async () => {}, tries: 10, killAfter: 6,
    });
    assert.equal(r.ok, false);
    assert.match(r.why, /still running/);
    assert.equal(kills.length, 10);
    assert.ok(kills.every(([pid]) => pid === 101));
    assert.deepEqual(kills.map(k => k[1]), [...Array(6).fill('SIGTERM'), ...Array(4).fill('SIGKILL')]);
    const none = await fleetRestore.stopAgent(100, { table: async () => table([[100, 1, '-zsh']]), kill: () => assert.fail('no kill'), sleep: async () => {} });
    assert.deepEqual(none, { ok: true, signalled: [] });
    assert.equal((await fleetRestore.stopAgent(100, { table: async () => null, sleep: async () => {} })).ok, false);
});

test('stopAgent: changed since the audit, or a busy shell → nothing signalled, nothing ok', async () => {
    const noKill = () => assert.fail('no kill');
    const right = table([[100, 1, '-zsh'], [105, 100, `claude --resume ${A}`]]);
    // Planned "no agent" (missing) but one has started; planned pid 101 but 105 runs.
    for (const planned of [null, 101]) {
        const r = await fleetRestore.stopAgent(100, { table: async () => right, kill: noKill, sleep: async () => {}, planned });
        assert.deepEqual([r.ok, r.changed, r.signalled.length], [false, true, 0]);
    }
    const vim = table([[100, 1, '-zsh'], [110, 100, 'vim notes.md']]);
    const r = await fleetRestore.stopAgent(100, { table: async () => vim, kill: noKill, sleep: async () => {}, planned: null });
    assert.equal(r.ok, false);
    assert.match(r.why, /shell is busy: vim/);
});

// ── repairFleet wiring ───────────────────────────────────────────────────────

test('repairFleet: Ctrl-U, then the exact line, then a re-audit; dryRun touches nothing', async () => {
    const writes = [];
    // A PTY pid nothing runs under: the audit sees no agent → `missing`.
    const tab = { id: 7, title: 'api', cwd: TMP, pty: { pid: 2 ** 30 }, restoreExpect: exact('claude', A),
        write: (s) => writes.push(s) };
    const sessions = () => [{ tabMgr: { order: [7], tabs: new Map([[7, tab]]) } }];

    const dry = await fleetRestore.repairFleet(sessions, { dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.results.map(r => [r.id, r.action, r.line]), [[7, 'would-relaunch', `claude --resume ${A}`]]);
    assert.equal(writes.length, 0);

    const stops = [];
    const out = await fleetRestore.repairFleet(sessions, { stop: async (pid, o) => { stops.push(o.planned); return { ok: true, signalled: [] }; },
        staggerMs: 0, verifyMs: 0 });
    await new Promise(r => setTimeout(r, 300));   // submitToTab's deferred Enter
    assert.equal(out.ok, true);
    assert.deepEqual(stops, [null, null]);   // the stop (no agent was judged), then the idle check before typing
    assert.equal(writes[0], '\x15');
    assert.ok(writes.some(w => w.includes(`claude --resume ${A}`) && !/--continue|\|\|/.test(w)));
    assert.equal(out.results[0].action, 'relaunched');
    assert.equal(out.results[0].after, 'missing');   // nothing really started in a test
    assert.equal(tab.sessionId, A);                   // stamped as the tab's identity
});

test('repairFleet: ps unavailable → refuses, touches nothing', async () => {
    const tab = { id: 1, cwd: TMP, pty: { pid: 5 }, restoreExpect: exact('claude', A), write: () => assert.fail('typed') };
    const out = await fleetRestore.repairFleet(() => [], {
        audit: async () => ({ report: { psOk: false, tabs: [], duplicates: [], counts: {} },
            pairs: [{ tab, row: row(1, 'missing', { agent: 'claude', sessionId: A }, null) }] }),
        stop: async () => assert.fail('stopped'),
    });
    assert.equal(out.ok, false);
    assert.match(out.error, /ps unavailable/);
});

test('repairFleet: a swap stops both tabs before launching either; a holder that will not stop blocks the launch', async () => {
    const events = [];
    const mk = (id, want, runs, pid) => ({ tab: { id, cwd: TMP, pty: { pid: id * 100 }, restoreExpect: exact('claude', want),
        write: (s) => { if (s.includes('--resume')) events.push(`launch ${id}`); } },
    row: { ...row(id, 'wrong-session', { agent: 'claude', sessionId: want }, { agent: 'claude', sessionId: runs }), pid } });
    const pairs = [mk(1, A, B, 101), mk(2, B, A, 201)];
    const audit = async () => ({ report: { psOk: true, registry: true, tabs: pairs.map(p => p.row), duplicates: [], counts: {} }, pairs });
    const stop = async (pid, o) => { events.push(`stop ${pid / 100}${o.planned == null ? ' idle' : ''}`); return { ok: true, signalled: [{ pid: o.planned }] }; };
    await fleetRestore.repairFleet(() => [], { audit, stop, staggerMs: 0, verifyMs: 0 });
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual(events.filter(e => !e.endsWith('idle')), ['stop 1', 'stop 2', 'launch 1', 'launch 2']);

    events.length = 0;
    const pairs2 = [mk(3, A, B, 301), mk(4, B, A, 401)];
    const out = await fleetRestore.repairFleet(() => [], {
        audit: async () => ({ report: { psOk: true, tabs: pairs2.map(p => p.row), duplicates: [], counts: {} }, pairs: pairs2 }),
        stop: async (pid, o) => (pid === 400 && o.planned != null ? { ok: false, signalled: [], why: 'agent pid 401 still running' } : { ok: true, signalled: [] }),
        staggerMs: 0, verifyMs: 0 });
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual(events, []);   // #3 wants A, still live in #4 → not launched
    assert.deepEqual(out.results.map(r => [r.id, r.action]).sort(), [[3, 'skipped'], [4, 'skipped']]);
    assert.match(out.results.find(r => r.id === 3).why, /still live in tab #4/);
});

test('planRepair: a launch still in flight and an argv-only claude read are left alone; a swap names its holders', () => {
    const pairs = [
        { tab: { id: 1, cwd: '/p', restoreExpect: exact('claude', A), restoreLaunchAt: Date.now() - 1000 },
            row: row(1, 'missing', { agent: 'claude', sessionId: A }, null) },
        { tab: { id: 2, cwd: '/p', restoreExpect: exact('claude', B), restoreLaunchAt: Date.now() - 10 * 60000 },
            row: row(2, 'missing', { agent: 'claude', sessionId: B }, null) },
        { tab: { id: 3, cwd: '/p', restoreExpect: exact('claude', C) },
            row: row(3, 'wrong-session', { agent: 'claude', sessionId: C }, { agent: 'claude', sessionId: D }) },
    ];
    const r = plan(pairs, { registry: false });
    assert.deepEqual(r.plan.map(x => x.id), [2]);
    assert.deepEqual(r.left.map(l => [l.id, l.why]), [[1, 'a launch is still in flight'], [3, 'claude registry unavailable']]);
    const swap = plan([
        { tab: { id: 1, cwd: '/p', restoreExpect: exact('claude', A) }, row: { ...row(1, 'wrong-session', { agent: 'claude', sessionId: A }, { agent: 'claude', sessionId: B }), pid: 11 } },
        { tab: { id: 2, cwd: '/p', restoreExpect: exact('claude', B) }, row: { ...row(2, 'wrong-session', { agent: 'claude', sessionId: B }, { agent: 'claude', sessionId: A }), pid: 22 } },
    ]).plan;
    assert.deepEqual(swap.map(p => [p.id, p.holders, p.pid]), [[1, [2], 11], [2, [1], 22]]);
});

// ── hints ────────────────────────────────────────────────────────────────────

test('writeHints keeps positions; applyHints lets a NEWER saved list keep its ids and fills only gaps', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'h-'));
    const n = si.writeHints(dir, [{ cwd: '/a', agent: 'codex', sessionId: C }, { cwd: '/b', agent: 'claude', sessionId: null },
        { cwd: '/c', agent: 'claude', sessionId: 'not-a-uuid' }], { now: 5000 });
    assert.equal(n, 1);
    const h = JSON.parse(fs.readFileSync(si.hintsPath(dir), 'utf8'));
    assert.deepEqual(h, { savedAt: 5000, tabs: [{ cwd: '/a', agent: 'codex', sessionId: C },
        { cwd: '/b', agent: 'claude', sessionId: null }, { cwd: '/c', agent: 'claude', sessionId: null }] });

    si.writeHints(dir, [{ cwd: '/a', agent: 'claude', sessionId: A }, { cwd: '/b', agent: 'claude', sessionId: B }], { now: 5000 });
    const entries = [{ cwd: '/a', agent: 'claude', sessionId: D }, { cwd: '/b', agent: 'claude' }];
    const r = si.applyHints(entries, dir, { now: 6000, savedAt: 5500 });   // tabs.json flushed after the hints
    assert.equal(r.applied, 1);
    assert.equal(entries[0].sessionId, D);
    assert.equal(entries[1].sessionId, B);

    si.writeHints(dir, [{ cwd: '/a', agent: 'claude', sessionId: A }], { now: 5000 });
    const older = [{ cwd: '/a', agent: 'claude', sessionId: D }];
    si.applyHints(older, dir, { now: 6000, savedAt: 4000 });   // a crash: the list predates the hints
    assert.equal(older[0].sessionId, A);
});

test('hintsFromAudit: observed identity per row, null where unread', () => {
    assert.deepEqual(cli.hintsFromAudit({ tabs: [
        { cwd: '/a', observed: { agent: 'codex', sessionId: C } },
        { cwd: '/b', observed: { agent: 'claude', sessionId: null } },
        { cwd: '/c', observed: null },
    ] }), [{ cwd: '/a', agent: 'codex', sessionId: C }, { cwd: '/b', agent: 'claude', sessionId: null }, { cwd: '/c', agent: null, sessionId: null }]);
});

test('hintsFromProcesses (older daemon): shells by a unique cwd, argv or registry ids, a shared cwd skipped', () => {
    const ps = [
        '  900     1 node /x/server/src/index.js',
        '  910   900 /bin/zsh -l',
        '  911   910 claude --resume ' + A,
        '  920   900 -zsh',
        '  921   920 codex resume ' + C + ' -c check_for_update_on_startup=false',
        '  930   900 /bin/zsh -l',
        '  931   930 claude',
        '  940   900 /usr/bin/ssh-agent',
    ].join('\n');
    const t = si.parseTable(ps);
    const cwd = { 910: '/a', 920: '/b', 930: '/c' };
    const tabs = [{ cwd: '/a' }, { cwd: '/b' }, { cwd: '/c' }];
    const agents = si.parseAgents(JSON.stringify([{ pid: 931, sessionId: D }]));
    assert.deepEqual(cli.hintsFromProcesses(tabs, { daemonPid: 900, table: t, cwdOf: p => cwd[p], agents }), [
        { cwd: '/a', agent: 'claude', sessionId: A },
        { cwd: '/b', agent: 'codex', sessionId: C },
        { cwd: '/c', agent: 'claude', sessionId: D },
    ]);
    // No registry: a bare claude gives no id. Tabs out of order: unique cwds still match.
    assert.deepEqual(cli.hintsFromProcesses([{ cwd: '/c' }, { cwd: '/a' }, { cwd: '/b' }], { daemonPid: 900, table: t, cwdOf: p => cwd[p] })
        .map(h => h.sessionId), [null, A, C]);
    // Two tabs and two shells on one cwd, out of position: ambiguous → no hint.
    const same = { 910: '/a', 920: '/a', 930: '/c' };
    assert.deepEqual(cli.hintsFromProcesses([{ cwd: '/c' }, { cwd: '/a' }, { cwd: '/a' }], { daemonPid: 900, table: t, cwdOf: p => same[p] })
        .map(h => h.agent), ['claude', null, null]);
    // ...and IN position too: spawn order is not tab order after a drag, so a
    // shared cwd never gets a positional hint.
    assert.deepEqual(cli.hintsFromProcesses([{ cwd: '/a' }, { cwd: '/a' }, { cwd: '/c' }], { daemonPid: 900, table: t, cwdOf: p => same[p] })
        .map(h => h.sessionId), [null, null, null]);
    // With tab ids: ascending id pairs with ascending shell pid, so tabs that
    // SHARE a cwd are told apart — even when dragged out of id order.
    const ids = [{ id: 3, cwd: '/c' }, { id: 1, cwd: '/a' }, { id: 2, cwd: '/a' }];
    assert.deepEqual(cli.hintsFromProcesses(ids, { daemonPid: 900, table: t, cwdOf: p => same[p], agents })
        .map(h => h.sessionId), [D, A, C]);
    // A pair whose cwd disagrees gets no hint (never a neighbour's thread).
    const moved = { 910: '/a', 920: '/zzz', 930: '/c' };
    assert.deepEqual(cli.hintsFromProcesses(ids, { daemonPid: 900, table: t, cwdOf: p => moved[p], agents })
        .map(h => h.sessionId), [D, A, null]);
    // A shell count that does not line up falls back to unique-cwd matching.
    assert.deepEqual(cli.hintsFromProcesses(ids.slice(0, 2), { daemonPid: 900, table: t, cwdOf: p => same[p], agents })
        .map(h => h.sessionId), [D, null]);
    assert.equal(cli.parseLsofCwd('p910\nfcwd\nn/Users/x/proj\n'), '/Users/x/proj');
    assert.equal(cli.parseLsofCwd(''), null);
});

test('restartCommand: launchctl kickstart on macOS, systemctl --user on linux', () => {
    assert.deepEqual(cli.restartCommand('app.s0a.web.local', { platform: 'darwin', uid: 501 }),
        ['launchctl', ['kickstart', '-k', 'gui/501/app.s0a.web.local']]);
    assert.deepEqual(cli.restartCommand('soa', { platform: 'linux', uid: 1000 }), ['systemctl', ['--user', 'restart', 'soa.service']]);
    assert.throws(() => cli.parseArgs(['--bogus']), /unknown argument/);
    assert.deepEqual(cli.parseArgs(['--no-repair', '--port', '4999', '--label', 'x']), { dryRun: false, repair: false, label: 'x', port: 4999 });
});

// ── the CLI against a stub daemon ─────────────────────────────────────────────

function stubDaemon({ fixedByRepair = true, initial, last = 'scheduled', noAudit = false }) {
    const calls = [];
    const bodies = [];
    let rows = initial;
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            calls.push(`${req.method} ${req.url}`);
            if (body) bodies.push(JSON.parse(body));
            const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
            const report = () => ({ ok: true, at: new Date().toISOString(), tabs: rows,
                duplicates: [], counts: {}, summary: `${rows.length} tab(s)` });
            if (noAudit && req.url.startsWith('/api/fleet/audit')) { res.statusCode = 404; return res.end('not found'); }
            // A new daemon's first ?last=1 is an ad-hoc sweep until the restore's audit has run.
            if (req.url === '/api/fleet/audit?last=1') return json(last === 'scheduled' ? { ...report(), cached: true, scheduled: true } : report());
            if (req.url === '/api/fleet/audit') return json(report());
            if (req.url === '/api/fleet/repair' && req.method === 'POST') {
                const results = rows.filter(r => r.status !== 'ok').map(r => ({ id: r.id, before: r.status, action: 'relaunched', after: fixedByRepair ? 'ok' : r.status }));
                if (fixedByRepair) rows = rows.map(r => ({ ...r, status: 'ok', observed: r.expected }));
                return json({ ok: true, results, summary: 'stub' });
            }
            res.statusCode = 404; res.end('not found');
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, calls, bodies, port: server.address().port })));
}

function runCli(args, { stateDir, port, extraEnv = {}, tools = {} }) {
    const bin = fs.mkdtempSync(path.join(TMP, 'bin-'));
    for (const [name, script] of Object.entries(tools)) fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
    const marker = path.join(bin, 'launchctl-called');
    for (const name of ['launchctl', 'systemctl']) {
        fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$@" > '${marker}'\n`, { mode: 0o755 });
    }
    const env = { ...process.env, SOA_WEB_STATE_DIR: stateDir, SOA_RESTART_DRY: '1', SOA_RESTART_AUDIT_WAIT_MS: '2000',
        SOA_WEB_CLAUDE_AGENTS: '0', PATH: `${bin}:${process.env.PATH}`, ...extraEnv };
    delete env.SOA_WEB_TAB;
    delete env.SOA_WEB_SESSION_TOKEN;
    return new Promise(resolve => execFile(process.execPath, [CLI, '--port', String(port), ...args], { env, timeout: 30000 },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr, launchctl: fs.existsSync(marker) })));
}

function stateWithLock(port) {
    const dir = fs.mkdtempSync(path.join(TMP, 'state-'));
    fs.writeFileSync(path.join(dir, 'daemon.lock'), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
    return dir;
}

const ROWS = [
    { id: 1, title: 'api', cwd: '/a', status: 'ok', expected: { agent: 'codex', sessionId: C }, observed: { agent: 'codex', sessionId: C } },
    { id: 2, title: 'web', cwd: '/b', status: 'wrong-session', expected: { agent: 'claude', sessionId: A }, observed: { agent: 'claude', sessionId: B } },
    { id: 3, title: 'sh', cwd: '/c', status: 'shell', expected: { agent: null, sessionId: null }, observed: null },
];

test('soa-restart (dry): writes hints from the audit, never calls launchctl, repairs, exits 0', async () => {
    const d = await stubDaemon({ initial: ROWS });
    try {
        const stateDir = stateWithLock(d.port);
        const r = await runCli([], { stateDir, port: d.port });
        assert.equal(r.code, 0, r.stdout + r.stderr);
        assert.equal(r.launchctl, false);
        assert.match(r.stdout, /DRY — would run: (launchctl kickstart -k gui\/\d+\/app\.s0a\.web\.local|systemctl --user restart)/);
        assert.match(r.stdout, /session hints for 2\/3 tab\(s\) \(from audit\)/);
        const h = JSON.parse(fs.readFileSync(si.hintsPath(stateDir), 'utf8'));
        assert.deepEqual(h.tabs, [{ cwd: '/a', agent: 'codex', sessionId: C }, { cwd: '/b', agent: 'claude', sessionId: B },
            { cwd: '/c', agent: null, sessionId: null }]);
        assert.ok(d.calls.includes('POST /api/fleet/repair'));
        assert.deepEqual(d.bodies, [{ dryRun: true }]);   // DRY only previews the repair
        assert.match(r.stdout, /restore audit done/);
        assert.match(r.stdout, /every tab is on its agent and thread/);
        const st = JSON.parse(fs.readFileSync(path.join(stateDir, 'soa-restart.last.json'), 'utf8'));
        assert.equal(st.code, 0);
    } finally { d.server.close(); }
});

test('soa-restart: mismatches left after the repair → exit 2; --no-repair never posts', async () => {
    const d = await stubDaemon({ initial: ROWS, fixedByRepair: false });
    try {
        const stateDir = stateWithLock(d.port);
        assert.equal((await runCli([], { stateDir, port: d.port })).code, 2);
        const n = d.calls.filter(c => c === 'POST /api/fleet/repair').length;
        const r = await runCli(['--no-repair', '--label', 'x.y'], { stateDir, port: d.port });
        assert.equal(r.code, 2);
        assert.match(r.stdout, /would run: (launchctl kickstart -k gui\/\d+\/x\.y|systemctl --user restart x\.y\.service)/);
        assert.equal(d.calls.filter(c => c === 'POST /api/fleet/repair').length, n);
    } finally { d.server.close(); }
});

test('soa-restart --dry-run prints the snapshot and writes nothing; no daemon → exit 1', async () => {
    const d = await stubDaemon({ initial: ROWS });
    try {
        const stateDir = stateWithLock(d.port);
        const r = await runCli(['--dry-run'], { stateDir, port: d.port });
        assert.equal(r.code, 0);
        assert.equal(fs.existsSync(si.hintsPath(stateDir)), false);
        assert.match(r.stdout, new RegExp(B));
        assert.ok(!d.calls.some(c => c.startsWith('POST')));
        assert.ok(!/would run/.test(r.stdout));
    } finally { d.server.close(); }
    const empty = fs.mkdtempSync(path.join(TMP, 'nolock-'));
    assert.equal((await runCli([], { stateDir: empty, port: 1 })).code, 1);
});

test('soa-restart: an ad-hoc sweep on ?last=1 is not the restore audit', async () => {
    const d = await stubDaemon({ initial: ROWS, last: 'adhoc' });
    try {
        const r = await runCli([], { stateDir: stateWithLock(d.port), port: d.port });
        assert.match(r.stdout, /no restore audit seen/);
    } finally { d.server.close(); }
});

test('soa-restart (older daemon): hints from ps + lsof + tabs.json; then no audit on the new code → exit 3', async () => {
    const d = await stubDaemon({ initial: ROWS, noAudit: true });
    try {
        const stateDir = stateWithLock(d.port);
        fs.writeFileSync(path.join(stateDir, 'tabs.json'), JSON.stringify({ tabs: [{ cwd: '/a' }, { cwd: '/b' }, { cwd: '/a2' }] }));
        const me = process.pid;
        const ps = [`${me + 1} ${me} /bin/zsh -l`, `${me + 2} ${me + 1} claude --resume ${A}`,
            `${me + 3} ${me} -zsh`, `${me + 4} ${me + 3} codex resume ${C}`, `${me + 5} ${me} -zsh`].join('\n');
        const tools = {
            ps: `#!/bin/sh\nprintf '%s\\n' '${ps.split('\n').join("' '")}'\n`,
            lsof: `#!/bin/sh\ncase "$3" in ${me + 1}) echo n/a;; ${me + 3}) echo n/b;; *) echo n/elsewhere;; esac\n`,
        };
        const r = await runCli([], { stateDir, port: d.port, tools, extraEnv: { SOA_WEB_CLAUDE_BIN: '/nonexistent' } });
        assert.equal(r.code, 3, r.stdout + r.stderr);
        assert.match(r.stdout, /session hints for 2\/3 tab\(s\) \(from ps\)/);
        assert.match(r.stderr, /audit is unavailable/);
        const h = JSON.parse(fs.readFileSync(si.hintsPath(stateDir), 'utf8'));
        assert.deepEqual(h.tabs, [{ cwd: '/a', agent: 'claude', sessionId: A }, { cwd: '/b', agent: 'codex', sessionId: C },
            { cwd: '/a2', agent: null, sessionId: null }]);
        assert.ok(!d.calls.some(c => c.startsWith('POST')));
    } finally { d.server.close(); }
});
