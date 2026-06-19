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

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const sm = require('../src/sessionManager');
const {
    classifyAgent, extractCtxPct, submitToTab, writeToTab, SessionManager,
    resolveCohort, makeEventFilter, isLocalRequest,
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

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });
