// Unit tests for the manager-agent core (sessionManager.js): the PTY status
// classifier, context-% extractor, reliable per-tab submit FIFO, the in-memory
// event ring + cursor self-heal, edge-triggered feed() transitions, the stuck
// sweep latch, exit/forget, and the snapshot. Pure + deterministic — no daemon,
// no PTYs, no Claude. Loopback HTTP / cohort behavior is covered by the
// integration smoke (scripts/manager-smoke.sh) against an isolated :7700 daemon.
//
// STATE_DIR + SUBMIT_DELAY_MS are resolved at require() time, so they are set
// first. `node --test` runs each file in its own process → no leakage.

const TMP = require('node:path').join(require('node:os').tmpdir(), `soa-web-mgr-test-${process.pid}`);
process.env.SOA_WEB_STATE_DIR = TMP;
process.env.SOA_WEB_SUBMIT_DELAY_MS = '5';   // fast FIFO for the submit test
// Meeting limits (relay max / poke cooldown / roster cap) are read from env at
// REQUIRE time too. Drop any ambient SOA_MEET_* so the meetings section below
// always asserts against the SHIPPED defaults — a developer with a tuned env
// would otherwise get different pass/fail results than CI.
for (const k of Object.keys(process.env)) if (k.startsWith('SOA_MEET_')) delete process.env[k];

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const sm = require('../src/sessionManager');
const {
    classifyAgent, extractCtxPct, submitToTab, writeToTab, SessionManager,
    resolveCohort, makeEventFilter, isLocalRequest, autoGroupFromCwd,
} = sm;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkTab(id, opts = {}) {
    const _writes = [];
    return {
        id,
        title: opts.title || `tab${id}`,
        cwd: opts.cwd || '/tmp',
        exited: false,
        write(d) { _writes.push(String(d)); },
        _writes,
    };
}
function mkMgr(tabs) {
    const map = new Map(tabs.map((t) => [t.id, t]));
    return {
        order: tabs.map((t) => t.id),
        get: (id) => map.get(id),
        scrollback: () => '',
        _map: map,
    };
}
function mkMan(tabs = []) {
    const tabMgr = mkMgr(tabs);
    const session = { tabMgr, send() {} };
    return new SessionManager(session);
}

// ── classifyAgent ───────────────────────────────────────────────────────────
test('classifyAgent: working beats everything', () => {
    assert.equal(classifyAgent('… esc to interrupt …', 'idle'), 'working');
    assert.equal(classifyAgent('Thinking… and Do you want to proceed?', 'idle'), 'working');
});
test('classifyAgent: attention on a real choice prompt', () => {
    assert.equal(classifyAgent('Do you want to proceed?', 'idle'), 'attention');
    assert.equal(classifyAgent('continue? (y/n)', 'idle'), 'attention');
});
test('classifyAgent: done on the Claude input-box footer', () => {
    assert.equal(classifyAgent('╭─────────╮\n│ > │\n╰─────────╯  bypass permissions on', 'working'), 'done');
});
test('classifyAgent: shell prompt → idle only when leaving a non-idle state', () => {
    const prompt = '\ntest@host:~/proj$ ';
    assert.equal(classifyAgent(prompt, 'working'), 'idle');
    assert.equal(classifyAgent(prompt, 'idle'), null); // already idle → no transition
});
test('classifyAgent: unrecognized output → null (no transition)', () => {
    assert.equal(classifyAgent('just some normal log output here', 'idle'), null);
});

// ── extractCtxPct ───────────────────────────────────────────────────────────
test('extractCtxPct: direct "N% context used"', () => {
    assert.equal(extractCtxPct('45% context used'), 45);
    assert.equal(extractCtxPct('context used: 30%'), 30);
});
test('extractCtxPct: "until auto-compact" / "context left" invert', () => {
    assert.equal(extractCtxPct('20% until auto-compact'), 80);
    assert.equal(extractCtxPct('context left: 25%'), 75);
    assert.equal(extractCtxPct('10% context remaining'), 90);
});
test('extractCtxPct: clamps and returns null on no match', () => {
    assert.equal(extractCtxPct('999% context used'), 100);
    assert.equal(extractCtxPct('no percentage at all'), null);
    assert.equal(extractCtxPct(''), null);
});
test('extractCtxPct: scans bottom-up, newest line wins', () => {
    assert.equal(extractCtxPct('10% context used\n70% context used'), 70);
});

// ── submitToTab: per-tab FIFO split-write ───────────────────────────────────
test('submitToTab: concurrent same-tab submits stay ordered as text,\\r,text,\\r', async () => {
    const tab = mkTab(1);
    submitToTab(tab, 'A');
    submitToTab(tab, 'B');
    await sleep(40);
    assert.deepEqual(tab._writes, ['A', '\r', 'B', '\r']);
});
test('submitToTab: tolerates a throwing write without breaking the chain', async () => {
    let calls = 0;
    const tab = { write() { calls++; if (calls === 1) throw new Error('pty gone'); } };
    submitToTab(tab, 'X'); // first write throws → chain must still resolve
    submitToTab(tab, 'Y');
    await sleep(40);
    assert.ok(calls >= 2, 'second submit still attempted after the first threw');
});

// ── event ring + cursor self-heal ───────────────────────────────────────────
test('event ring: _emit increments seq and _eventsSince filters by cursor', () => {
    const man = mkMan([mkTab(1)]);
    man._emit('working', 1);
    man._emit('done', 1);
    assert.equal(man._seq, 2);
    const all = man._eventsSince(0, null);
    assert.equal(all.events.length, 2);
    assert.equal(all.cursor, 2);
    assert.equal(all.dropped, 0);
    const tail = man._eventsSince(1, null);
    assert.equal(tail.events.length, 1);
    assert.equal(tail.events[0].kind, 'done');
});
test('event ring: evicts beyond EVENT_CAP and reports dropped for an evicted cursor', () => {
    const man = mkMan([mkTab(1)]);
    for (let i = 0; i < 600; i++) man._emit('working', 1);
    assert.equal(man._events.length, 500, 'ring capped at 500');
    assert.equal(man._seq, 600);
    assert.equal(man._events[0].seq, 101, 'oldest retained seq is 101');
    const r = man._eventsSince(50, null); // 50 is below the floor (101)
    assert.equal(r.dropped, 50, 'seqs 51..100 were evicted → 50 dropped');
    assert.equal(r.cursor, 600);
});
test('event ring: cursor above head → synthetic daemon-restart event', () => {
    const man = mkMan([mkTab(1)]);
    man._emit('working', 1); // head = 1
    const r = man._eventsSince(999, null);
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0].kind, 'daemon-restart');
    assert.equal(r.cursor, 1);
    assert.equal(r.dropped, 0);
});
test('event ring: filter excludes non-matching events', () => {
    const man = mkMan([mkTab(1), mkTab(2)]);
    man._emit('working', 1);
    man._emit('attention', 2);
    const onlyTab2 = man._eventsSince(0, (e) => e.id === 2);
    assert.equal(onlyTab2.events.length, 1);
    assert.equal(onlyTab2.events[0].id, 2);
    assert.equal(onlyTab2.cursor, 2, 'cursor advances to head even when events are filtered out');
});

// ── feed(): edge-triggered transitions ──────────────────────────────────────
test('feed: idle→working emits once; duplicate status does not re-emit', () => {
    const man = mkMan([mkTab(1)]);
    man.feed(1, 'esc to interrupt');
    man.feed(1, 'esc to interrupt'); // still working
    const evs = man._eventsSince(0, null).events.filter((e) => e.id === 1);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].kind, 'working');
});
test('feed: highContext fires once on the upward crossing only', () => {
    const man = mkMan([mkTab(1)]);
    man.feed(1, '\n50% context used\n'); // below threshold, no event
    man.feed(1, '\n85% context used\n'); // crosses 80 → one event
    man.feed(1, '\n90% context used\n'); // already high → no event
    const hi = man._eventsSince(0, (e) => e.kind === 'highContext').events;
    assert.equal(hi.length, 1);
    assert.equal(hi[0].ctxPct, 85);
});

// ── stuck sweep latch ───────────────────────────────────────────────────────
test('emitStuckSweep: one stuck per stall episode, re-arms after output resumes', () => {
    const man = mkMan([mkTab(1)]);
    man.feed(1, 'esc to interrupt');            // status working
    const s = man.tabs.get(1);
    s.lastOutputAt = Date.now() - 5 * 60 * 1000; // silent > STUCK_MS
    man.emitStuckSweep();
    man.emitStuckSweep();                         // latched → no duplicate
    let stuck = man._eventsSince(0, (e) => e.kind === 'stuck').events;
    assert.equal(stuck.length, 1, 'exactly one stuck while latched');
    s.lastOutputAt = Date.now();                  // output resumed → re-arm
    man.emitStuckSweep();
    s.lastOutputAt = Date.now() - 5 * 60 * 1000;  // stalls again
    man.emitStuckSweep();
    stuck = man._eventsSince(0, (e) => e.kind === 'stuck').events;
    assert.equal(stuck.length, 2, 'a fresh stall fires a new stuck');
});

// ── exit / forget / reportCtx / snapshot ────────────────────────────────────
test('noteExit: emits exited with last status then forgets the tab', () => {
    const man = mkMan([mkTab(1)]);
    man.feed(1, 'esc to interrupt'); // working
    man.noteExit(1);
    const ex = man._eventsSince(0, (e) => e.kind === 'exited').events;
    assert.equal(ex.length, 1);
    assert.equal(ex[0].from, 'working');
    assert.equal(man.tabs.has(1), false);
});
test('reportCtx: clamps to 0..100', () => {
    const man = mkMan([mkTab(1)]);
    man.reportCtx(1, 150); assert.equal(man.tabs.get(1).ctxPct, 100);
    man.reportCtx(1, -5);  assert.equal(man.tabs.get(1).ctxPct, 0);
    man.reportCtx(1, 42);  assert.equal(man.tabs.get(1).ctxPct, 42);
});
test('snapshot: counts reflect per-tab status flags', () => {
    const man = mkMan([mkTab(1), mkTab(2), mkTab(3)]);
    man.feed(1, 'esc to interrupt');       // working
    man.feed(2, 'Do you want to proceed?'); // attention
    const snap = man.snapshot();
    assert.equal(snap.counts.total, 3);
    assert.equal(snap.counts.working, 1);
    assert.equal(snap.counts.attention, 1);
});

// ── scheduling ──────────────────────────────────────────────────────────────
test('schedule/unschedule: newest-per-tab wins; _fireDue submits due text', async () => {
    const tab = mkTab(1);
    const man = mkMan([tab]);
    man.schedule(1, Date.now() + 3600_000, 'later');     // far future
    man.schedule(1, Date.now() - 1000, 'continue now');  // past + replaces (newest-per-tab)
    assert.equal(man.state.schedules.length, 1, 'only one pending schedule per tab');
    man._fireDue();
    await sleep(20);
    assert.ok(tab._writes.includes('continue now'), 'due schedule was submitted');
    assert.equal(man.state.schedules.length, 0, 'fired schedule removed');
});

// ── isLocalRequest: the loopback trust gate (CRITICAL tunnel-bypass fix) ──────
test('isLocalRequest: genuine local caller is trusted', () => {
    assert.equal(isLocalRequest({ ip: '127.0.0.1', headers: {} }), true);
    assert.equal(isLocalRequest({ ip: '::1', headers: {} }), true);
    assert.equal(isLocalRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: {} }), true);
});
test('isLocalRequest: a tunneled/forwarded request is REJECTED even from a loopback socket', () => {
    // cloudflared dials localhost → socket is loopback, but it injects these headers.
    assert.equal(isLocalRequest({ ip: '127.0.0.1', headers: { 'cf-connecting-ip': '203.0.113.7' } }), false);
    assert.equal(isLocalRequest({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.7' } }), false);
    assert.equal(isLocalRequest({ ip: '127.0.0.1', headers: { 'x-real-ip': '203.0.113.7' } }), false);
    assert.equal(isLocalRequest({ ip: '127.0.0.1', headers: { 'forwarded': 'for=203.0.113.7' } }), false);
});
test('isLocalRequest: a non-loopback socket is rejected', () => {
    assert.equal(isLocalRequest({ ip: '10.0.0.5', headers: {} }), false);
});
test('isLocalRequest: a valid local key is trusted even with forwarding headers / non-loopback', () => {
    const { LOCAL_KEY } = require('../src/localKey');
    assert.equal(isLocalRequest({ ip: '203.0.113.7', headers: { 'x-soa-local-key': LOCAL_KEY, 'x-forwarded-for': '203.0.113.7' } }), true);
});
test('isLocalRequest: a wrong key falls back to the loopback+no-forwarding-header rule', () => {
    assert.equal(isLocalRequest({ ip: '127.0.0.1', headers: { 'x-soa-local-key': 'nope' } }), true);
    assert.equal(isLocalRequest({ ip: '127.0.0.1', headers: { 'x-soa-local-key': 'nope', 'x-forwarded-for': '1.2.3.4' } }), false);
});

// ── resolveCohort: selector → ids (no accidental fleet-wide fan-out) ──────────
const SNAP = {
    sessions: [
        { id: 1, status: 'working', attention: false, idle: false, stuck: false, highContext: false, limited: false },
        { id: 2, status: 'attention', attention: true, idle: false, stuck: false, highContext: true, limited: false },
        { id: 3, status: 'done', attention: false, idle: true, stuck: false, highContext: false, limited: true },
    ],
};
test('resolveCohort: number / numeric-string / array resolve to live ids', () => {
    assert.deepEqual(resolveCohort(SNAP, 2), [2]);
    assert.deepEqual(resolveCohort(SNAP, '3'), [3]);
    assert.deepEqual(resolveCohort(SNAP, [1, 3, 99]), [1, 3]); // 99 dropped (not live)
    assert.deepEqual(resolveCohort(SNAP, 99), []);
});
test('resolveCohort: "all" and signal cohorts', () => {
    assert.deepEqual(resolveCohort(SNAP, 'all'), [1, 2, 3]);
    assert.deepEqual(resolveCohort(SNAP, 'working'), [1]);
    assert.deepEqual(resolveCohort(SNAP, 'attention'), [2]);
    assert.deepEqual(resolveCohort(SNAP, 'highContext'), [2]);
    assert.deepEqual(resolveCohort(SNAP, 'limited'), [3]);
    assert.deepEqual(resolveCohort(SNAP, 'idle'), [3]);
});
test('resolveCohort: unknown/empty/whitespace/null → [] (never an accidental fleet fan-out)', () => {
    assert.deepEqual(resolveCohort(SNAP, 'frobnicate'), []);
    assert.deepEqual(resolveCohort(SNAP, ''), []);
    assert.deepEqual(resolveCohort(SNAP, '   '), []);
    assert.deepEqual(resolveCohort(SNAP, undefined), []);
    assert.deepEqual(resolveCohort(SNAP, null), []);
});
// ── user-defined groups: `group:<name>` selector + cwd auto-group ─────────────
const GSNAP = {
    sessions: [
        { id: 1, group: 'frontend' },
        { id: 2, group: 'api' },
        { id: 3, group: 'frontend' },
        { id: 4, group: 'ungrouped' },
    ],
};
test('resolveCohort: group:<name> selects that group; missing/empty group fails closed', () => {
    assert.deepEqual(resolveCohort(GSNAP, 'group:frontend'), [1, 3]);
    assert.deepEqual(resolveCohort(GSNAP, 'group:api'), [2]);
    assert.deepEqual(resolveCohort(GSNAP, 'group:GHOST'), []);   // no members → []
    assert.deepEqual(resolveCohort(GSNAP, 'group:'), []);         // no name → []
    assert.deepEqual(resolveCohort(GSNAP, 'group'), []);          // not a group selector
});
test('autoGroupFromCwd: project folder name, trailing-slash & null tolerant', () => {
    assert.equal(autoGroupFromCwd('/Users/x/proj/frontend'), 'frontend');
    assert.equal(autoGroupFromCwd('/Users/x/proj/api/'), 'api');   // trailing slash
    assert.equal(autoGroupFromCwd(''), 'ungrouped');
    assert.equal(autoGroupFromCwd(null), 'ungrouped');
    assert.equal(autoGroupFromCwd(undefined), 'ungrouped');
});

// ── makeEventFilter: self-hide + kind restriction ────────────────────────────
test('makeEventFilter: hides own tab and restricts to kinds', () => {
    const hideSelf = makeEventFilter({ self: 2 });
    assert.equal(hideSelf({ id: 2, kind: 'attention' }), false);
    assert.equal(hideSelf({ id: 3, kind: 'attention' }), true);
    const onlyStuck = makeEventFilter({ kinds: ['stuck'] });
    assert.equal(onlyStuck({ id: 1, kind: 'stuck' }), true);
    assert.equal(onlyStuck({ id: 1, kind: 'working' }), false);
    const both = makeEventFilter({ self: 2, kinds: ['stuck'] });
    assert.equal(both({ id: 2, kind: 'stuck' }), false); // self excluded even if kind matches
    assert.equal(both({ id: 3, kind: 'stuck' }), true);
    assert.equal(makeEventFilter({})({ id: 9, kind: 'anything' }), true); // no constraints → pass
});

// ── writeToTab: submit:false now shares the FIFO (no interleave) ──────────────
test('writeToTab: a chained raw write lands AFTER a pending submit\'s Enter (no garble)', async () => {
    const tab = mkTab(1);
    submitToTab(tab, 'hello');   // writes 'hello' now, '\r' deferred ~5ms
    writeToTab(tab, 'world');    // must wait for the submit (incl. its '\r'), not interleave
    await sleep(40);
    assert.deepEqual(tab._writes, ['hello', '\r', 'world'], 'world must not land between hello and its Enter');
});

// ── schedule resolves by cwd, not the ephemeral tab id (restart-safe) ─────────
test('_fireDue: resolves the target by cwd so a reassigned id after restart does not misfire', async () => {
    const a = mkTab(1, { cwd: '/proj/a' });
    const b = mkTab(2, { cwd: '/proj/b' });
    const man = mkMan([a, b]);
    man.schedule(1, Date.now() - 1000, 'GO');   // captures cwd /proj/a
    // Simulate a daemon restart: ids reassigned — /proj/a is now id 2, /proj/b id 1.
    const a2 = mkTab(2, { cwd: '/proj/a' });
    const b2 = mkTab(1, { cwd: '/proj/b' });
    man.session.tabMgr = mkMgr([b2, a2]);
    man._fireDue();
    await sleep(10);
    assert.ok(a2._writes.includes('GO'), 'fired into the tab with the matching cwd');
    assert.ok(!b2._writes.includes('GO'), 'did NOT fire into the wrong project that inherited the old id');
});
test('snapshot: resumeAt follows the cwd-matched tab after a restart reassigns ids', () => {
    const man = mkMan([mkTab(1, { cwd: '/proj/a' }), mkTab(2, { cwd: '/proj/b' })]);
    man.schedule(1, Date.now() + 3600_000, 'continue');  // pending for /proj/a (id 1)
    man.session.tabMgr = mkMgr([mkTab(1, { cwd: '/proj/b' }), mkTab(2, { cwd: '/proj/a' })]); // restart: /proj/a → id 2
    const snap = man.snapshot();
    const at = (id) => snap.sessions.find((s) => s.id === id).resumeAt;
    assert.ok(at(2), 'resumeAt shows on the tab now holding the scheduled cwd');
    assert.equal(at(1), null, 'not on the wrong tab that inherited the old id');
});
test('snapshot: resumeAt does NOT leak onto a live sibling sharing the cwd (no restart)', () => {
    const man = mkMan([mkTab(1, { cwd: '/proj/a' }), mkTab(2, { cwd: '/proj/a' })]);
    man.schedule(1, Date.now() + 3600_000, 'continue'); // only id 1 is scheduled
    const snap = man.snapshot();
    const at = (id) => snap.sessions.find((s) => s.id === id).resumeAt;
    assert.ok(at(1), 'the scheduled tab shows resumeAt');
    assert.equal(at(2), null, 'the unscheduled sibling sharing the cwd does NOT');
});
test('_fireDue: with duplicate cwds, prefers the EXACT scheduled tab id (no ambiguous misfire)', async () => {
    const t1 = mkTab(1, { cwd: '/proj/dup' });
    const t2 = mkTab(2, { cwd: '/proj/dup' });   // two live tabs, same dir
    const man = mkMan([t1, t2]);
    man.schedule(2, Date.now() - 1000, 'GO');     // scheduled for id 2 specifically
    man._fireDue();
    await sleep(10);
    assert.ok(t2._writes.includes('GO'), 'fired into the exact scheduled id (live id+cwd match)');
    assert.ok(!t1._writes.includes('GO'), 'did not fire into the other tab sharing the cwd');
});

// ── stuck guard: a "working"-pinned tab that is actually at its DONE input box
//    must NOT trip a spurious 'stuck' (fix #8, the safe non-classifier version) ──
test('emitStuckSweep: no stuck for a working-pinned tab whose recent shows a DONE box', () => {
    const man = mkMan([mkTab(1)]);
    man.feed(1, 'esc to interrupt');                 // status → working
    const s = man.tabs.get(1);
    // It then finished and is idle at its input box, but a trailing gerund keeps it
    // classified 'working'. recent now shows the DONE chrome:
    s.recent = 'Summary: the next step is testing.\n╭─────╮\n│ > │\n╰─────╯\n ⏵⏵ accept edits on';
    s.lastOutputAt = Date.now() - 5 * 60 * 1000;      // silent > STUCK_MS
    man.emitStuckSweep();
    const stuck = man._eventsSince(0, (e) => e.kind === 'stuck').events;
    assert.equal(stuck.length, 0, 'a finished agent at its input box is not "stuck"');
});
test('emitStuckSweep: still flags a genuinely stuck working tab (no done box)', () => {
    const man = mkMan([mkTab(1)]);
    man.feed(1, 'esc to interrupt');
    const s = man.tabs.get(1);
    s.recent = 'Running tests… esc to interrupt';     // actively working, no done box
    s.lastOutputAt = Date.now() - 5 * 60 * 1000;
    man.emitStuckSweep();
    const stuck = man._eventsSince(0, (e) => e.kind === 'stuck').events;
    assert.equal(stuck.length, 1, 'a hung working agent is still flagged stuck');
});
test('emitStuckSweep: a hung agent is STILL flagged even when the box+footer coexist with a frozen spinner', () => {
    // The modern Claude TUI renders the input box persistently DURING active work,
    // so a real hung agent's buffer has the box AND a frozen "esc to interrupt".
    // looksDone() must not suppress stuck here (box present but live-work marker too).
    const man = mkMan([mkTab(1)]);
    man.feed(1, 'esc to interrupt');
    const s = man.tabs.get(1);
    s.recent = 'Editing files…\n╭─────╮\n│ > │\n╰─────╯\n esc to interrupt   ⏵⏵ accept edits on';
    s.lastOutputAt = Date.now() - 5 * 60 * 1000;
    man.emitStuckSweep();
    const stuck = man._eventsSince(0, (e) => e.kind === 'stuck').events;
    assert.equal(stuck.length, 1, 'box + frozen spinner ⇒ genuinely stuck, not suppressed');
});

// ── destroy: stops the leaked schedule timer ─────────────────────────────────
test('destroy: clears the 15s schedule timer (no post-GC leak)', () => {
    const man = mkMan([mkTab(1)]);
    assert.ok(man._schedTimer, 'timer armed on construct');
    man.destroy();
    assert.equal(man._schedTimer, null, 'timer cleared on destroy');
});

// ════════════════════════════════════════════════════════════════════════════
// ── agent group meetings ────────────────────────────────────────────────────
// A meeting types real prompts into real Claude sessions, so every rule here is
// a spend control as much as a correctness control. The pure helpers
// (meetRosterIds / shouldPoke / meetPokeLine) are unit-tested directly; the
// relay budget is driven end-to-end through tickMeetings against fake tabs.
// ════════════════════════════════════════════════════════════════════════════
const {
    meetRosterIds, shouldPoke, meetPokeLine,
    MEET_RELAY_MAX, MEET_POKE_MS, MEET_MAX_MEMBERS,
} = sm;

// A `recent` buffer looksDone() accepts: the DONE input box with NO live-work
// marker. Set straight onto the tab state rather than via feed(), so the poke
// gate is exercised without also driving a status transition.
const DONE_BOX = '╭─────╮\n│ > │\n╰─────╯\n ⏵⏵ accept edits on';

// A SessionManager whose meeting state starts EMPTY. manager.json is a real file
// under TMP and every SessionManager reloads it at construct, so a room opened by
// one test would otherwise come back as "already open" in the next one.
function mkMeetMan(tabs) {
    const man = mkMan(tabs);
    man.state.meetings = {};
    return man;
}
// Mark a member ready for a turn: finished at its input box, plenty of context.
function ready(man, id) {
    const s = man._state(id);
    s.recent = DONE_BOX; s.status = 'done'; s.ctxPct = 10;
    return s;
}
// Pretend the poke cooldown has elapsed. MEET_POKE_MS clamps to a 1000ms floor,
// so a test needing a second poke round against the SAME tab would otherwise
// have to burn a real second per round. Seats are keyed by LIVE tab id (hot
// state, rebuilt after a restart), so ask _seat rather than rebuilding the key.
function coolDown(man, room, tabs) {
    for (const t of tabs) man._seat(room, t.id).lastPokeAt = 0;
}
// Every 'meeting-skip' reason emitted so far — this is what makes a stalled room
// diagnosable from `soa-sessions watch` instead of by guesswork.
const skipWhys = (man) => man._eventsSince(0, (e) => e.kind === 'meeting-skip').events.map((e) => e.detail);

test('meeting limits: the SHIPPED defaults are the ones this section assumes', () => {
    assert.equal(MEET_RELAY_MAX, 2, 'agents may answer each other twice per human message; 0 would make every meeting one-shot');
    assert.equal(MEET_POKE_MS, 8_000, 'minimum gap between two pokes into the same tab');
    assert.equal(MEET_MAX_MEMBERS, 6, 'each extra member is another full Claude turn per round');
});

// ── meeting:<room> cohort resolution ────────────────────────────────────────
const MSNAP = {
    sessions: [
        { id: 1, meeting: 'standup' },
        { id: 2, meeting: null },
        { id: 3, meeting: 'standup' },
        { id: 4, meeting: 'retro' },
    ],
};
test('resolveCohort: meeting:<room> selects that room; a typo FAILS CLOSED', () => {
    assert.deepEqual(resolveCohort(MSNAP, 'meeting:standup'), [1, 3]);
    assert.deepEqual(resolveCohort(MSNAP, 'meeting:retro'), [4]);
    // Every one of these must be [] — a meeting selector that fell through to a
    // fleet-wide fan-out would broadcast a private room's context to every agent.
    assert.deepEqual(resolveCohort(MSNAP, 'meeting:GHOST'), [], 'no such room → nobody');
    assert.deepEqual(resolveCohort(MSNAP, 'meeting:'), [], 'empty room name → nobody');
    assert.deepEqual(resolveCohort(MSNAP, 'meeting'), [], 'bare "meeting" is not a selector → nobody');
    assert.deepEqual(resolveCohort(MSNAP, 'meeting:   '), [], 'whitespace-only room name → nobody');
    assert.deepEqual(resolveCohort(MSNAP, 'meeting:Standup'), [], 'room names match EXACTLY — a near-miss must not fan out');
});

// ── meetRosterIds: cwd-keyed roster → live tab ids ──────────────────────────
const rosterSnap = (rows) => ({ sessions: rows });

test('meetRosterIds: an EXACT id still pointing at the same cwd resolves as "id"', () => {
    const snap = rosterSnap([{ id: 4, cwd: '/proj/api', title: 'api' }]);
    const [e] = meetRosterIds(snap, [{ cwd: '/proj/api', tabId: 4 }]);
    assert.equal(e.id, 4);
    assert.equal(e.resolved, 'id');
    assert.equal(e.title, 'api', 'the LIVE title rides along, so the roster never shows the name the tab had at join time');
});

test('meetRosterIds: after a restart REASSIGNS ids, a member follows its cwd', () => {
    // Same rule _fireDue uses for schedules, generalized: tab ids are ephemeral
    // (every daemon restart / soa-restore-fleet respawn renumbers them), cwds are not.
    const snap = rosterSnap([{ id: 1, cwd: '/proj/web', title: 'web' }, { id: 2, cwd: '/proj/api', title: 'api' }]);
    const [e] = meetRosterIds(snap, [{ cwd: '/proj/api', tabId: 1 }]);   // joined as #1, now #2
    assert.equal(e.id, 2, 'poked the tab that actually holds the project, not the tab that inherited the number');
    assert.equal(e.resolved, 'cwd');
    const [noHint] = meetRosterIds(snap, [{ cwd: '/proj/web' }]);
    assert.equal(noHint.id, 1, 'a member with no id hint at all still resolves through its unique cwd');
    assert.equal(noHint.resolved, 'cwd');
});

test('meetRosterIds: a STALE id must NOT land on a live sibling sharing the cwd', () => {
    // Two tabs open in one directory is genuinely ambiguous, and poking the wrong
    // agent mid-meeting is much worse than a member sitting the round out.
    const snap = rosterSnap([
        { id: 1, cwd: '/proj/elsewhere', title: 'elsewhere' },  // the joined id, now a DIFFERENT project
        { id: 2, cwd: '/proj/dup', title: 'dup-a' },
        { id: 3, cwd: '/proj/dup', title: 'dup-b' },
    ]);
    const [e] = meetRosterIds(snap, [{ cwd: '/proj/dup', tabId: 1 }]);
    assert.equal(e.id, null, 'the stale id resolved to nobody rather than to #1 (wrong project) or a coin-flip between #2/#3');
    assert.equal(e.resolved, 'ambiguous');
});

test('meetRosterIds: two live tabs in one cwd → id null, resolved "ambiguous"', () => {
    const snap = rosterSnap([{ id: 5, cwd: '/proj/dup' }, { id: 6, cwd: '/proj/dup' }]);
    const [e] = meetRosterIds(snap, [{ cwd: '/proj/dup', tabId: 99 }]);
    assert.equal(e.id, null);
    assert.equal(e.resolved, 'ambiguous', 'the roster UI can say WHY a member is missing instead of silently dropping the row');
    const [hit] = meetRosterIds(snap, [{ cwd: '/proj/dup', tabId: 6 }]);
    assert.equal(hit.id, 6, 'an exact live id+cwd match still wins inside a duplicated cwd');
    assert.equal(hit.resolved, 'id');
});

test('meetRosterIds: SIBLING tabs in one cwd are told apart by TITLE after a restart', () => {
    // TabManager deliberately supports two tabs in one project (it auto-titles
    // them api-1 / api-2), so a cwd-keyed roster collapses two agents into one.
    // Once a restart has thrown away both join-time ids, the title is the only
    // thing left that still distinguishes them.
    const snap = rosterSnap([
        { id: 1, cwd: '/proj/dup', title: 'api-2' },
        { id: 2, cwd: '/proj/dup', title: 'api-1' },
    ]);
    const roster = meetRosterIds(snap, [
        { cwd: '/proj/dup', title: 'api-1', tabId: 11 },   // both join-time ids are gone
        { cwd: '/proj/dup', title: 'api-2', tabId: 12 },
    ]);
    assert.deepEqual(roster.map((e) => e.id), [2, 1], 'each member followed its own title, not the id that happened to survive');
    assert.deepEqual(roster.map((e) => e.resolved), ['title', 'title']);
});

test('meetRosterIds: two members can NEVER resolve to the same live tab', () => {
    // One surviving tab standing in for two members would give that terminal two
    // seats — two prompts per round, and a phantom "live" count in the roster.
    const snap = rosterSnap([{ id: 9, cwd: '/proj/dup', title: 'api-2' }]);
    const roster = meetRosterIds(snap, [
        { cwd: '/proj/dup', tabId: 5 },
        { cwd: '/proj/dup', title: 'api-2', tabId: 6 },
    ]);
    assert.equal(roster.filter((e) => e.id === 9).length, 1, 'the survivor was claimed exactly once');
    assert.deepEqual(roster.map((e) => e.resolved), ['cwd', 'gone'], 'the member left without a tab reports gone instead of double-booking one');
});

test('meetRosterIds: a DEPARTED member resolves to "gone", never onto somebody else', () => {
    const snap = rosterSnap([{ id: 1, cwd: '/proj/api' }]);
    const [e] = meetRosterIds(snap, [{ cwd: '/proj/vanished', tabId: 7 }]);
    assert.equal(e.id, null);
    assert.equal(e.resolved, 'gone', 'a closed tab reads as gone — inheriting #1 would type a stranger\'s meeting into an unrelated project');
    assert.deepEqual(meetRosterIds(snap, []), [], 'an empty roster folds to nothing');
    assert.deepEqual(meetRosterIds(snap, null), []);
    assert.equal(meetRosterIds({}, [{ cwd: '/x', tabId: 1 }])[0].resolved, 'gone', 'a snapshot with no sessions list (a daemon mid-restart) is tolerated, not fatal');
});

// ── shouldPoke: every gate, independently, WITH its why string ──────────────
// The all-clear row: resolved id, not limited, finished at its input box, cool,
// low context, active project. Each test below spoils exactly ONE field.
const READY_ROW = { id: 7, limited: false, status: 'done', looksDone: true, lastPokeAt: 0, ctxPct: 12, lifecycle: 'active' };
const gate = (over, opts) => shouldPoke({ ...READY_ROW, ...over }, { now: 1_000_000, relayHops: 0, ...opts });

test('shouldPoke: the all-clear row is the only thing that opens the gate', () => {
    assert.deepEqual(gate({}), { ok: true }, 'a resolved, idle, cool, low-context, active member gets its turn');
    assert.equal(gate({ ctxPct: null }).ok, true, 'an unknown context % is not a reason to hold back — most tabs never print one');
    assert.equal(gate({ lifecycle: null }).ok, true, 'an unlabelled project is active by default');
});

test('shouldPoke: the RELAY BUDGET outranks every other reason', () => {
    assert.equal(gate({}, { relayHops: MEET_RELAY_MAX }).why, 'relay-budget');
    assert.equal(gate({}, { relayHops: MEET_RELAY_MAX + 5 }).why, 'relay-budget');
    assert.equal(gate({}, { relayHops: MEET_RELAY_MAX - 1 }).ok, true, 'one hop below the max still gets a turn');
    // Budget is the LOOP guard, so it must win over every "but this agent looks
    // ready" condition — otherwise an echo storm hides behind a cooldown message.
    assert.equal(gate({ limited: true, status: 'attention', looksDone: false }, { relayHops: MEET_RELAY_MAX }).why, 'relay-budget');
    assert.equal(gate({}, { relayHops: 3, relayMax: 9 }).ok, true, 'an explicit relayMax override wins over the module constant');
});

test('shouldPoke: limited / attention / mid-turn members are each held back', () => {
    assert.equal(gate({ limited: true }).why, 'limited', 'typing at a rate-limited agent just queues garbage that lands when the limit lifts');
    // submitToTab presses Enter, which would ANSWER a permission dialog instead
    // of starting a turn — the worst possible misfire in this whole feature.
    assert.equal(gate({ status: 'attention' }).why, 'attention');
    assert.equal(gate({ status: 'attention', looksDone: true }).why, 'attention', 'a visible input box does NOT override a pending dialog');
    assert.equal(gate({ looksDone: false }).why, 'busy', 'mid-turn: wait for the input box rather than interleaving with live work');
});

test('shouldPoke: cooldown, high context and a non-active lifecycle each hold back', () => {
    assert.equal(gate({ lastPokeAt: 999_500 }, { pokeMs: 1000 }).why, 'cooldown', 'a burst of messages inside one tick must not become a burst of prompts');
    assert.equal(gate({ lastPokeAt: 999_000 }).why, 'cooldown', 'the default MEET_POKE_MS window applies when no override is passed');
    assert.equal(gate({ lastPokeAt: 998_000 }, { pokeMs: 1000 }).ok, true, 'past the window the member is eligible again');
    assert.equal(gate({ ctxPct: 80 }).why, 'high-context', 'at the ceiling a fresh turn likely triggers a compact mid-meeting');
    assert.equal(gate({ ctxPct: 79 }).ok, true, 'just below the threshold is still fine');
    assert.equal(gate({ lifecycle: 'inactive' }).why, 'lifecycle', 'a shelved project must not be woken by someone else\'s meeting');
    assert.equal(gate({ lifecycle: 'archive' }).why, 'lifecycle');
});

test('shouldPoke: an unresolved member and a missing row FAIL CLOSED', () => {
    assert.equal(gate({ id: null }).why, 'unresolved', 'an ambiguous/gone roster entry is never poked — the id is the only thing we could type into');
    assert.equal(shouldPoke(null).why, 'gone');
    assert.equal(shouldPoke(undefined).why, 'gone', 'a vanished row returns a reason instead of throwing inside the 3s tick');
});

// ── meetPokeLine: the prompt actually typed into a member's terminal ────────
test('meetPokeLine: inlines the recent lines, names the reply command, carries the do-not-block rule', () => {
    const msgs = [
        { seq: 1, who: 'user', text: 'what is left before we ship?' },
        { seq: 2, who: '7', text: 'api is green' },
        { seq: 3, who: '9', text: 'web needs one more fix' },
    ];
    const line = meetPokeLine('standup', msgs);
    // Inlining the transcript is what lets an agent answer WITHOUT spending a
    // tool call to catch up: a poke that only said "you have mail" would cost a
    // read round-trip per member per hop.
    assert.ok(line.includes('you: "what is left before we ship?"'), 'the human is labelled "you", not "#user"');
    assert.ok(line.includes('#7: "api is green"'), 'agent lines carry a #id speaker label, so a reply can be addressed to someone');
    assert.ok(line.includes('#9: "web needs one more fix"'));
    assert.ok(line.startsWith('[meeting standup] 3 new'), 'the room and the delta size lead the line');
    assert.ok(line.includes('soa-meet say standup'), 'the exact reply command is named — an agent left to guess it burns a whole turn');
    assert.ok(/Do not block on `soa-meet watch`/.test(line), 'an agent parked in a blocking watch never ends its turn and stalls the entire room');
    assert.ok(/answer, then stop/.test(line), 'the stop rule keeps a room a groupchat instead of N monologues');

    const short = meetPokeLine('standup', msgs, { recentK: 1 });
    assert.ok(short.includes('#9: "web needs one more fix"'), 'the newest line is the one that survives the trim');
    assert.ok(!short.includes('api is green'), 'only the last k lines are inlined, so a burst cannot blow one prompt up');
    assert.ok(short.startsWith('[meeting standup] 3 new'), 'the count stays the REAL backlog size, not the inlined slice');
    // This string is typed into a TUI and then Enter is pressed: a newline in it
    // would auto-submit half a prompt.
    assert.ok(!/[\r\n]/.test(meetPokeLine('standup', [{ who: 'user', text: 'a' }])), 'the poke is a single line');
    assert.ok(meetPokeLine('standup', []).includes('0 new'), 'an empty delta still renders rather than throwing');
});

// ── tickMeetings: pokes are [text, \r] and never a raw write in between ─────
test('tickMeetings: a HUMAN line pokes every member as exactly [pokeText, \\r]', async () => {
    const a = mkTab(1, { cwd: '/proj/api', title: 'api' });
    const b = mkTab(2, { cwd: '/proj/web', title: 'web' });
    const man = mkMeetMan([a, b]);
    ready(man, 1); ready(man, 2);
    const room = 'tick-human';
    assert.equal(man.meetStart({ room, members: [{ id: 1 }, { id: 2 }] }).ok, true);
    man.meetSay(room, { who: 'user', text: 'ship the release notes', via: 'user' });
    man.tickMeetings();
    await sleep(40);   // submitToTab writes on a promise chain, not synchronously
    for (const t of [a, b]) {
        assert.equal(t._writes.length, 2, `#${t.id} got exactly one poke (text + Enter), not a re-poke per tick`);
        assert.ok(t._writes[0].startsWith(`[meeting ${room}]`), 'the poke text lands first');
        assert.equal(t._writes[1], '\r', 'the carriage return lands AFTER the text — a raw write between them would glue two prompts into one garbled auto-submitted line');
        assert.ok(t._writes[0].includes('ship the release notes'), 'the human line is inlined, so the agent needs no catch-up read');
    }
    man.tickMeetings();
    await sleep(40);
    assert.equal(a._writes.length, 2, 'a tick with nothing new pokes nobody — the cheapest of all the spend controls');
});

// ── the relay budget, end to end ────────────────────────────────────────────
test('tickMeetings: agent hops SPEND the relay budget, a human line RECHARGES it', async () => {
    const tabs = [
        mkTab(1, { cwd: '/proj/relay-api', title: 'api' }),
        mkTab(2, { cwd: '/proj/relay-web', title: 'web' }),
        mkTab(3, { cwd: '/proj/relay-ios', title: 'ios' }),
    ];
    const man = mkMeetMan(tabs);
    tabs.forEach((t) => ready(man, t.id));
    const room = 'relay-budget';
    assert.equal(man.meetStart({ room, members: tabs.map((t) => ({ id: t.id })) }).ok, true);
    assert.equal(man.meetView(room).mode, 'free', 'three members answer freely; round mode would poke one per tick and break the hop accounting below');
    const counts = () => tabs.map((t) => t._writes.length);

    man.meetSay(room, { who: 'user', text: 'status round please', via: 'user' });
    man.tickMeetings();
    await sleep(40);
    assert.deepEqual(counts(), [2, 2, 2], 'a human message pokes every member');
    assert.equal(man.meetView(room).relayHops, 0, 'the human line did NOT spend the budget it just recharged');

    for (let hop = 1; hop <= MEET_RELAY_MAX; hop++) {
        const speaker = tabs[(hop - 1) % tabs.length];
        coolDown(man, room, tabs);
        const before = counts();
        man.meetSay(room, { who: speaker.id, cwd: speaker.cwd, text: `hop ${hop} from ${speaker.title}`, via: 'cli' });
        man.tickMeetings();
        await sleep(40);
        const after = counts();
        tabs.forEach((t, i) => {
            // Briefing an agent on its own line is the tightest possible echo
            // loop: it replies, gets told about its reply, replies again.
            if (t === speaker) assert.equal(after[i], before[i], `#${t.id} was NOT briefed on its own line (hop ${hop})`);
            else assert.equal(after[i], before[i] + 2, `#${t.id} was relayed the reply of #${speaker.id} (hop ${hop})`);
        });
        assert.equal(man.meetView(room).relayHops, hop, 'one agent-driven round = exactly one hop');
    }

    coolDown(man, room, tabs);
    const quiet = counts();
    man.meetSay(room, { who: tabs[0].id, cwd: tabs[0].cwd, text: 'one more thought', via: 'cli' });
    man.tickMeetings();
    await sleep(40);
    assert.deepEqual(counts(), quiet, 'once relayHops >= relayMax NOBODY is poked — the room goes quiet and waits for the user');
    assert.ok(skipWhys(man).includes(`${room}: relay-budget`), 'the reason is emitted, so a quiet room is diagnosable instead of mysterious');

    coolDown(man, room, tabs);
    man.meetSay(room, { who: 'user', text: 'good — ship it', via: 'user' });
    assert.equal(man.meetView(room).relayHops, 0, 'only a HUMAN message recharges the budget');
    man.tickMeetings();
    await sleep(40);
    counts().forEach((n, i) => assert.ok(n > quiet[i], `#${tabs[i].id} is poked again after the user speaks`));
});

// ── a blocked poke is DEFERRED, not dropped ─────────────────────────────────
test('tickMeetings: a cooldown DEFERS a poke — the seat cursor must NOT advance', async () => {
    const a = mkTab(1, { cwd: '/proj/defer', title: 'solo' });
    const man = mkMeetMan([a]);
    ready(man, 1);
    const room = 'defer-cooldown';
    assert.equal(man.meetStart({ room, members: [{ id: 1 }] }).ok, true);
    man.meetSay(room, { who: 'user', text: 'first question', via: 'user' });
    man.tickMeetings();
    await sleep(40);
    assert.equal(a._writes.length, 2, 'the first poke went out');
    const seat = man._seat(room, a.id);
    const parked = seat.cursor;

    man.meetSay(room, { who: 'user', text: 'second thought, do X first', via: 'user' });
    man.tickMeetings();
    await sleep(40);
    assert.equal(a._writes.length, 2, 'no second prompt inside MEET_POKE_MS — two prompts back to back garble into one auto-submitted line');
    assert.equal(seat.cursor, parked, 'the seat cursor did NOT advance: advancing it on a blocked poke would lose that line FOREVER');
    assert.ok(skipWhys(man).includes(`${room}: cooldown`), 'the deferral is visible as a meeting-skip event, not silence');

    coolDown(man, room, [a]);
    man.tickMeetings();
    await sleep(40);
    assert.equal(a._writes.length, 4, 'exactly one more poke once the window passed');
    assert.ok(a._writes[2].includes('second thought'), 'the line the cooldown held back rode the NEXT poke — deferred, never dropped');
});

// ── sibling tabs in one project are two distinct members ───────────────────
test('tickMeetings: SIBLING tabs in one cwd get separate turns; the uninvited one is left out', async () => {
    // The bug this guards: identify members by cwd and two siblings collapse into
    // one member, every tab in the folder is tagged a participant, and the
    // "don't brief a member on its own line" filter silently skips the sibling.
    const a = mkTab(1, { cwd: '/proj/sib', title: 'api-1' });
    const b = mkTab(2, { cwd: '/proj/sib', title: 'api-2' });
    const c = mkTab(3, { cwd: '/proj/sib', title: 'api-3' });   // same folder, NOT invited
    const man = mkMeetMan([a, b, c]);
    [1, 2, 3].forEach((id) => ready(man, id));
    const room = 'sibling-room';
    const started = man.meetStart({ room, members: [{ id: 1 }, { id: 2 }] });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.room.members.length, 2, 'two tabs in one directory are TWO members, not one');
    assert.equal(started.room.live, 2);

    const snap = man.snapshot();
    assert.equal(snap.sessions.find((s) => s.id === 3).meeting, null, 'the uninvited sibling is not tagged as a participant');
    assert.equal(snap.counts.inMeeting, 2);
    assert.equal(man.meetSay(room, { who: 3, cwd: c.cwd, text: 'butting in', via: 'cli' }).code, 'NOT_MEMBER',
        'sharing a directory with a member is not membership — otherwise any sibling agent could speak in the room');

    man.meetSay(room, { who: 'user', text: 'both of you, status', via: 'user' });
    man.tickMeetings();
    await sleep(40);
    assert.equal(a._writes.length, 2, 'sibling api-1 got its own poke');
    assert.equal(b._writes.length, 2, 'sibling api-2 got its own poke');
    assert.equal(c._writes.length, 0, 'the uninvited sibling was never typed into');

    coolDown(man, room, [a, b]);
    man.meetSay(room, { who: 1, cwd: a.cwd, text: 'api-1 done', via: 'cli' });
    man.tickMeetings();
    await sleep(40);
    assert.equal(b._writes.length, 4, 'the sibling in the SAME directory still hears the reply — a cwd-based filter would have skipped its turn');
    assert.equal(a._writes.length, 2, 'the author was not briefed on its own line');
});

// ── policy refusals: the CODES the 409 contract is built on ─────────────────
test('meetSay: an ADJOURNED room refuses new lines (ROOM_CLOSED)', () => {
    const a = mkTab(1, { cwd: '/proj/closed', title: 'api' });
    const man = mkMeetMan([a]);
    const room = 'refuse-closed';
    assert.equal(man.meetStart({ room, members: [{ id: 1 }] }).ok, true);
    man.meetEnd(room, 'wrapped');
    const r = man.meetSay(room, { who: 'user', text: 'anyone still here?', via: 'user' });
    assert.equal(r.ok, false);
    // The CODE is the contract: meetings.js maps it to 409 and the client renders
    // "this meeting has adjourned" rather than a generic failure.
    assert.equal(r.code, 'ROOM_CLOSED');
    assert.equal(man.meetView(room).open, false);
    assert.equal(man.snapshot().counts.inMeeting, 0, 'an adjourned room stops counting its members as in-session');
    assert.equal(man.meetSay('refuse-ghost', { who: 'user', text: 'hi' }).code, 'NO_ROOM', 'an unknown room is NO_ROOM (404), never a silent success');
});

test('meetSay: a NON-MEMBER cannot speak in the room (NOT_MEMBER)', () => {
    const a = mkTab(1, { cwd: '/proj/member', title: 'api' });
    const b = mkTab(2, { cwd: '/proj/outsider', title: 'web' });
    const man = mkMeetMan([a, b]);
    const room = 'refuse-member';
    assert.equal(man.meetStart({ room, members: [{ id: 1 }] }).ok, true);
    assert.equal(man.meetSay(room, { who: 1, cwd: a.cwd, text: 'api here', via: 'cli' }).ok, true);
    const r = man.meetSay(room, { who: 2, cwd: b.cwd, text: 'let me in', via: 'cli' });
    assert.equal(r.ok, false);
    // Membership is checked by CWD, not by the claimed id — otherwise any local
    // process could talk its way into a room it was never invited to.
    assert.equal(r.code, 'NOT_MEMBER');
    assert.equal(man.meetRead(room).msgs.filter((m) => m.text === 'let me in').length, 0, 'the refused line never reached the ledger');
    assert.equal(man.meetSay(room, { who: 'user', text: 'go on', via: 'user' }).ok, true, 'the manager is always allowed to speak — the human runs the room');
});

test('meetStart: the ROSTER CAP refuses an oversized room (ROSTER_CAP)', () => {
    // MEMBER_BUSY is checked per member INSIDE the loop, BEFORE the cap check, so
    // every tab here must sit in a fresh cwd that is not already in a room.
    const tabs = Array.from({ length: MEET_MAX_MEMBERS + 1 }, (_, i) => mkTab(i + 1, { cwd: `/proj/cap-${i}`, title: `t${i}` }));
    const man = mkMeetMan(tabs);
    const r = man.meetStart({ room: 'refuse-cap', members: tabs.map((t) => ({ id: t.id })) });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ROSTER_CAP', 'one member over the cap is one more full Claude turn per round, every round');
    assert.ok(/too many members/.test(r.error), 'the error says why, so a 409 can render as a sentence');
    assert.equal(man.state.meetings['refuse-cap'], undefined, 'the refused room was not half-created — a phantom open room would block the name forever');
    const okr = man.meetStart({ room: 'refuse-cap-ok', members: tabs.slice(0, MEET_MAX_MEMBERS).map((t) => ({ id: t.id })) });
    assert.equal(okr.ok, true, 'exactly at the cap is allowed');
    assert.equal(okr.room.members.length, MEET_MAX_MEMBERS);
});

test('meetStart: an agent cannot sit in TWO rooms at once (MEMBER_BUSY)', () => {
    const a = mkTab(1, { cwd: '/proj/busy', title: 'api' });
    const b = mkTab(2, { cwd: '/proj/free', title: 'web' });
    const man = mkMeetMan([a, b]);
    assert.equal(man.meetStart({ room: 'busy-one', members: [{ id: 1 }] }).ok, true);
    const r = man.meetStart({ room: 'busy-two', members: [{ id: 1 }, { id: 2 }] });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MEMBER_BUSY', 'two rooms poking one terminal would interleave two conversations into one prompt stream');
    assert.equal(man.state.meetings['busy-two'], undefined, 'the second room was not created around the free member either');
    assert.equal(man.meetStart({ room: 'busy-one', members: [{ id: 2 }] }).code, 'ROOM_OPEN', 'reusing an OPEN room name is refused rather than silently replacing its roster');
    man.meetLeave('busy-one', { id: 1 });
    assert.equal(man.meetStart({ room: 'busy-three', members: [{ id: 1 }] }).ok, true, 'once the first room released the cwd the agent can sit in another');
});

// ── the snapshot fields the UIs and the cohort selector share ───────────────
test('snapshot: sessions[].meeting + counts.inMeeting are what meeting:<room> reads', () => {
    const man = mkMeetMan([
        mkTab(1, { cwd: '/proj/snap-a', title: 'a' }),
        mkTab(2, { cwd: '/proj/snap-b', title: 'b' }),
        mkTab(3, { cwd: '/proj/snap-c', title: 'c' }),
    ]);
    const room = 'snap-room';
    assert.equal(man.meetStart({ room, members: [{ id: 1 }, { id: 2 }] }).ok, true);
    const snap = man.snapshot();
    assert.equal(snap.sessions.find((s) => s.id === 1).meeting, room);
    assert.equal(snap.sessions.find((s) => s.id === 3).meeting, null, 'a tab outside the room reads null, never the room name');
    assert.equal(snap.counts.inMeeting, 2);
    // One field, three readers (cohort selector, dashboard, phone) — three
    // separate lookups is how they drift apart.
    assert.deepEqual(resolveCohort(snap, `meeting:${room}`), [1, 2]);
    const view = snap.meetings.find((v) => v.room === room);
    assert.equal(view.open, true);
    assert.equal(view.live, 2);
    assert.equal(view.relayMax, MEET_RELAY_MAX, 'the view carries the max so the client can render "quiet, waiting for you" without a second constant');
    assert.deepEqual(view.members.map((m) => m.resolved), ['id', 'id']);
    man.meetEnd(room, 'done');
    const after = man.snapshot();
    assert.equal(after.sessions.find((s) => s.id === 1).meeting, null, 'adjourning releases the members');
    assert.equal(after.counts.inMeeting, 0);
    assert.deepEqual(resolveCohort(after, `meeting:${room}`), [], 'the cohort empties with the room — no fan-out into an adjourned meeting');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });
