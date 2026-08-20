// Unit tests for meetStore — the append-only meeting ledger behind agent group
// meetings. Everything here is either pure or one file under a throwaway state
// dir: no daemon, no express, no PTYs. That is deliberate — meetStore is the one
// module in the meeting stack that a bare checkout must be able to test, so this
// file requires nothing but node builtins and `../src/meetStore`.
//
// The ledger's two silent-failure modes get the most coverage, because neither
// throws when it breaks: a text cap applied AFTER the write (which turns one
// message into a torn multi-syscall append), and a non-monotonic `seq` (which
// makes the relay's `> cursor` comparison drop a line forever).
//
// busDir() resolves per call, but the env is set up BEFORE the require anyway so
// the file layout is identical to how the daemon sees it.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), `soa-web-meetstore-test-${process.pid}`);
process.env.SOA_WEB_STATE_DIR = TMP;
// Ambient SOA_MEET_*/SOA_BUS_DIR would silently move the cap, the channel prefix
// or the whole ledger dir out from under these assertions — always test the
// shipped defaults.
delete process.env.SOA_BUS_DIR;
for (const k of Object.keys(process.env)) if (k.startsWith('SOA_MEET_')) delete process.env[k];

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../src/meetStore');

// One raw ledger line in the shipped soa-bus record shape: the OUTER record is a
// literal bus message and the meeting payload is JSON inside its `msg` string.
// Built by hand (not via append) so the fold/parse rules can be tested against
// out-of-order, hostile and non-meeting lines a plain `soa-bus` write could leave.
function mkLine(seq, over = {}) {
    const p = { v: 'say', room: 'r', seq, who: 'user', text: `m${seq}`, via: 'user', ...over };
    return JSON.stringify({ t: seq, from: 'you (manager)', msg: JSON.stringify(p), chan: 'meet-r' });
}

// A pair cut in half is an unpaired surrogate: JSON.stringify happily writes it
// as a lone \udXXX escape and every reader renders '�' forever after.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ── append / read round-trip ────────────────────────────────────────────────
test('append+read: a said line round-trips through the temp state dir', () => {
    const room = 'rt-roundtrip';
    const rec = store.append(room, { v: 'say', room, who: 'user', text: 'api is green', via: 'user' }, 'you (manager)');
    assert.ok(rec && rec.seq > 0, 'append returns the written record with its assigned seq — the caller advances a cursor with it');
    // The ledger must live under the STATE_DIR, never ~/.soa-web: a test (or a
    // second daemon) writing into the real fleet's bus dir is the exact
    // cross-contamination the 4-step resolution chain exists to prevent.
    assert.equal(store.chanFile(room), path.join(TMP, 'a2a', 'meet-rt-roundtrip.jsonl'));
    assert.ok(fs.existsSync(store.chanFile(room)), 'the append created the channel file');

    const { msgs, cursor } = store.read(room);
    assert.equal(msgs.length, 1);
    assert.deepEqual(
        { room: msgs[0].room, who: msgs[0].who, from: msgs[0].from, text: msgs[0].text, via: msgs[0].via, seq: msgs[0].seq },
        { room, who: 'user', from: 'you (manager)', text: 'api is green', via: 'user', seq: rec.seq },
        'every wire field survives the JSON-in-JSON layering — a renamed field here reads as an empty chat bubble on the client',
    );
    assert.equal(cursor, rec.seq, 'cursor is the max seq SEEN, so the next read resumes exactly after this line');
});

test('read: a missing room returns no msgs and does NOT rewind the caller cursor', () => {
    const r = store.read('rt-never-existed', { sinceSeq: 42 });
    assert.deepEqual(r.msgs, []);
    assert.equal(r.cursor, 42, 'an empty read echoes the cursor back — returning 0 would replay the whole transcript on the next tick');
});

// ── the IM cap is applied BEFORE the write (one atomic append) ──────────────
test('append: the IM cap is applied BEFORE the write, so one message is ONE line', () => {
    const room = 'rt-cap';
    const long = 'x'.repeat(4000);
    store.append(room, { v: 'say', room, who: '7', text: long, via: 'cli' }, '#7 api');
    const raw = fs.readFileSync(store.chanFile(room), 'utf8');
    // macOS has no flock: atomicity here is "the record is small enough to land
    // in one write syscall". Capping after serializing would put a 4KB line on
    // disk and a torn append would corrupt a neighbour's line, not just its own.
    assert.equal(raw.split('\n').filter(Boolean).length, 1, 'exactly one physical line was appended');
    assert.ok(raw.length < store.MAXREC, `the serialized record stays under MAXREC (${raw.length} < ${store.MAXREC})`);
    assert.ok(!raw.includes('x'.repeat(store.msgCap() + 1)), 'the oversized text never reached the file — proof the cap ran before the write, not after the read');

    const m = store.read(room).msgs[0];
    assert.equal(Array.from(m.text).length, store.msgCap(), 'stored text is exactly the cap in CODE POINTS');
    assert.ok(m.text.endsWith('…'), 'truncation is marked, so a reader can tell a trimmed line from a terse one');
});

test('capLine: truncation slices by CODE POINT — never a lone surrogate', () => {
    // '🛰' is one astral code point = two UTF-16 units. A naive String.slice(0,9)
    // cuts the 5th satellite in half and emits an unpaired surrogate.
    const out = store.capLine('🛰'.repeat(50), 10);
    assert.equal(out, '🛰'.repeat(9) + '…');
    assert.equal(Array.from(out).length, 10, 'the cap counts code points, which is what a user perceives as length');
    assert.equal(out.length, 19, 'nine 2-unit code points + the ellipsis — a UTF-16 slice would have produced 10 units');
    assert.ok(!LONE_SURROGATE.test(out), 'no unpaired surrogate: a half-cut emoji renders as � in every client, forever');

    // Mixed ASCII + astral, so the boundary lands mid-pair rather than on it.
    assert.equal(store.capLine('ab' + '🛰'.repeat(20), 10), 'ab' + '🛰'.repeat(7) + '…');
    assert.ok(!LONE_SURROGATE.test(store.capLine('ab' + '🛰'.repeat(20), 10)));
    // An absurdly small cap floors at 8 rather than producing a bare '…' — a
    // one-character "message" is worse than a slightly-too-long one.
    assert.equal(store.capLine('🛰'.repeat(50), 2), '🛰'.repeat(7) + '…');
    // Under the cap: returned verbatim, no ellipsis and no reflow.
    assert.equal(store.capLine('🛰🛰', 10), '🛰🛰');
});

test('capLine: newlines and runs of whitespace COLLAPSE to single spaces', () => {
    // A meeting line is one atomic append and one chat bubble. A raw newline
    // would also be a second JSONL line the moment anything writes it unescaped.
    assert.equal(store.capLine('line one\nline two\r\n\tline three'), 'line one line two line three');
    assert.equal(store.capLine('  padded   out  '), 'padded out');
    assert.equal(store.capLine(null), '', 'null/undefined collapse to empty rather than the string "null"');
    assert.equal(store.capLine(undefined), '');

    const room = 'rt-newline';
    store.append(room, { v: 'say', room, who: 'user', text: 'first\nsecond', via: 'user' }, 'you (manager)');
    const m = store.read(room).msgs[0];
    assert.equal(m.text, 'first second');
    assert.ok(!m.text.includes('\n'), 'the stored text carries no newline — one message stays one line on disk and one bubble on screen');
});

// ── channel-name normalization ──────────────────────────────────────────────
test('chanName: a space, a slash and a colon all normalize to the SAME channel', () => {
    // Same normalization as soa-bus's norm() — so a room name can be typed
    // freely without escaping a path separator into the filename.
    assert.equal(store.chanName('a b'), 'meet-a_b');
    assert.equal(store.chanName('a/b'), 'meet-a_b');
    assert.equal(store.chanName('a:b'), 'meet-a_b');
    assert.equal(store.chanFile('a b'), store.chanFile('a/b'), 'the collision is real: these three room names share ONE ledger file');
    // Two rooms that differ only in a normalized character therefore READ each
    // other's transcript. Documented here so a future room-name rule (rejecting
    // or normalizing at meetStart) has a test to change rather than discover.
    store.append('rt x', { v: 'say', room: 'rt x', who: 'user', text: 'said in the space room', via: 'user' }, 'you (manager)');
    const bleed = store.read('rt/x').msgs.map(m => m.text);
    assert.deepEqual(bleed, ['said in the space room'], 'the slash-named room reads the space-named room verbatim');
});

test('chanName: a room name can never escape the bus dir (path traversal)', () => {
    // The room name arrives straight off an HTTP path param (/api/meetings/:room).
    assert.equal(store.chanName('../../etc/passwd'), 'meet-.._.._etc_passwd');
    assert.equal(path.dirname(store.chanFile('../x')), store.busDir(), 'every ledger file stays a direct child of the bus dir');
    assert.equal(store.chanName(null), 'meet-', 'a null room degrades to the bare prefix instead of "meet-null"');
});

// ── nextSeq: strictly increasing, even inside one millisecond ───────────────
test('nextSeq: strictly increasing even within ONE millisecond', () => {
    // seq is the relay cursor's currency. Two lines sharing a seq inside one
    // millisecond make the tick's `m.seq > seat.cursor` filter drop one of them
    // FOREVER — the agent is never briefed on a line that is visibly in the file.
    const t0 = Date.now();
    let prev = 0;
    for (let i = 0; i < 3000; i++) {
        const s = store.nextSeq();
        assert.ok(s > prev, `seq must strictly increase (got ${s} after ${prev})`);
        prev = s;
    }
    assert.ok(prev >= t0 + 2999, 'the +1 clamp ran ahead of the wall clock, which is exactly what makes a same-millisecond burst collision-free');
});

// ── foldTranscript: ordering, since-filter, limit ───────────────────────────
test('foldTranscript: sorts by seq, drops junk lines, and never throws', () => {
    const lines = [
        mkLine(3), mkLine(1), mkLine(2),          // appended out of order
        'not json at all',                         // a human poked the file
        '',                                        // trailing-newline artifact
        JSON.stringify({ t: 1, from: 'x', msg: 'not json either', chan: 'meet-r' }),
        JSON.stringify({ t: 1, from: 'x', msg: JSON.stringify({ v: 'ping' }), chan: 'meet-r' }), // not a 'say'
    ];
    const all = store.foldTranscript(lines, 0, 100);
    assert.deepEqual(all.map(m => m.seq), [1, 2, 3], 'ordering is by seq, not by file position — a degraded direct-append can land late');
    assert.equal(all.length, 3, 'unparseable and non-say lines are skipped, never fatal: one bad line must not end a read');
    assert.deepEqual(store.foldTranscript(null, 0, 10), [], 'a null line list folds to nothing instead of throwing inside the 3s tick');
});

test('foldTranscript: `since` is EXCLUSIVE and `limit` keeps the TAIL', () => {
    const lines = [mkLine(1), mkLine(2), mkLine(3)];
    assert.deepEqual(store.foldTranscript(lines, 2, 100).map(m => m.seq), [3], 'seq == since is already seen — including it would re-brief an agent on its own last line');
    assert.deepEqual(store.foldTranscript(lines, 0, 2).map(m => m.seq), [2, 3], 'a limited read keeps the NEWEST lines; keeping the head would brief an agent on stale context');
    assert.equal(store.foldTranscript(lines, 0, 0).length, 3, 'limit 0 falls back to the default rather than reading nothing at all');
    assert.equal(store.foldTranscript(lines, 99, 100).length, 0, 'a cursor past the head yields nothing — no poke, no spend');
    const many = Array.from({ length: 600 }, (_, i) => mkLine(i + 1));
    assert.equal(store.foldTranscript(many, 0, 9999).length, 500, 'limit is clamped to 500 so one busy room cannot inline a whole transcript into a prompt');
});

// ── headSeq ─────────────────────────────────────────────────────────────────
test('headSeq: 0 on a MISSING file, max seq on an out-of-order one', () => {
    // headSeq baselines a joiner's cursor. Throwing (or returning NaN) here would
    // break meetStart for every brand-new room — the common case.
    assert.equal(store.headSeq('rt-no-such-room'), 0, 'a room with no ledger baselines at 0 instead of exploding');
    const room = 'rt-head';
    fs.mkdirSync(store.busDir(), { recursive: true });
    fs.writeFileSync(store.chanFile(room), [mkLine(50), mkLine(900), mkLine(120), 'junk'].join('\n') + '\n');
    assert.equal(store.headSeq(room), 900, 'the max seq wins, not the last line — a late direct-append must not lower the head');
});

// ── the line cap trims to the TAIL ──────────────────────────────────────────
test('append: an overgrown ledger is trimmed to its TAIL, keeping the newest lines', () => {
    const room = 'rt-trim';
    fs.mkdirSync(store.busDir(), { recursive: true });
    // MAXLINES+1 pre-existing lines, written directly so the test costs one write
    // instead of 5000 append+trim passes.
    const pre = Array.from({ length: store.MAXLINES + 1 }, (_, i) => mkLine(i + 1));
    fs.writeFileSync(store.chanFile(room), pre.join('\n') + '\n');
    store.append(room, { v: 'say', room, seq: 9_000_000, who: 'user', text: 'the newest line', via: 'user' }, 'you (manager)');

    const lines = fs.readFileSync(store.chanFile(room), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, store.TRIM_TO, `trimmed to TRIM_TO (${store.TRIM_TO}) lines`);
    const msgs = store.foldTranscript(lines, 0, 500);
    assert.equal(msgs[msgs.length - 1].text, 'the newest line', 'the line that triggered the trim survived it — trimming before appending would eat the message being written');
    // A room that runs long keeps its tail, not its opening: the relay only ever
    // reads forward from a cursor, so old lines are dead weight.
    assert.equal(store.headSeq(room), 9_000_000);
    assert.equal(store.read(room, { sinceSeq: 0, limit: 1 }).msgs[0].text, 'the newest line');
    assert.equal(store.foldTranscript(lines, 0, 500).filter(m => m.seq === 1).length, 0, 'the opening lines are gone, so a stale cursor cannot resurrect them');
});

// ── busDir(): the 4-step resolution chain ───────────────────────────────────
test('busDir: SOA_BUS_DIR wins, then STATE_DIR/a2a, then the homedir probe', () => {
    // This chain MUST stay identical to scripts/soa-bus and scripts/soa-work: if
    // the daemon resolves one dir while the shell-side `soa-meet` resolves
    // another, every participant writes to a ledger nobody else reads — a room
    // where all the messages vanish with no error anywhere.
    const savedBus = process.env.SOA_BUS_DIR;
    const savedState = process.env.SOA_WEB_STATE_DIR;
    try {
        process.env.SOA_BUS_DIR = '/tmp/soa-explicit-bus';
        assert.equal(store.busDir(), '/tmp/soa-explicit-bus', 'an explicit SOA_BUS_DIR is used verbatim — no a2a suffix appended');
        assert.equal(store.chanFile('x'), path.join('/tmp/soa-explicit-bus', 'meet-x.jsonl'));

        delete process.env.SOA_BUS_DIR;
        process.env.SOA_WEB_STATE_DIR = '/tmp/soa-state';
        assert.equal(store.busDir(), path.join('/tmp/soa-state', 'a2a'), 'STATE_DIR gets the a2a suffix, matching every other bus writer');

        delete process.env.SOA_WEB_STATE_DIR;
        const local = path.join(os.homedir(), '.soa-web-local');
        const expected = fs.existsSync(local)
            ? path.join(local, 'a2a')
            : path.join(os.homedir(), '.soa-web', 'a2a');
        assert.equal(store.busDir(), expected, 'with no env at all it probes ~/.soa-web-local before ~/.soa-web — the probe every CLI performs, which stateDir.js skips');
    } finally {
        // Resolved per call, so a leaked env var here would point every later
        // test at the real fleet's ledger.
        if (savedBus == null) delete process.env.SOA_BUS_DIR; else process.env.SOA_BUS_DIR = savedBus;
        process.env.SOA_WEB_STATE_DIR = savedState;
    }
    assert.equal(store.busDir(), path.join(TMP, 'a2a'), 'the temp-dir isolation is restored');
});

// ── parseRecord ─────────────────────────────────────────────────────────────
test('parseRecord: tolerant of junk, and falls back to the outer timestamp for seq', () => {
    assert.equal(store.parseRecord(''), null);
    assert.equal(store.parseRecord('   '), null);
    assert.equal(store.parseRecord('{not json'), null);
    assert.equal(store.parseRecord('[1,2,3]'), null, 'a JSON non-object is not a record');
    assert.equal(store.parseRecord(JSON.stringify({ t: 1, msg: JSON.stringify({ v: 'say' }) })).seq, 1,
        'a payload with no seq borrows the outer bus timestamp rather than sorting as seq 0');
    const m = store.parseRecord(JSON.stringify({ t: 5, msg: JSON.stringify({ v: 'say', seq: 7, room: 'r' }) }));
    assert.deepEqual({ who: m.who, text: m.text, via: m.via, from: m.from },
        { who: '?', text: '', via: 'cli', from: '?' },
        'missing fields degrade to placeholders — a partial line still renders instead of crashing the read');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });
