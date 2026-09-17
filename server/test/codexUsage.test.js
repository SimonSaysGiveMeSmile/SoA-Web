const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the engine at a fixture instead of ~/.codex. Set before the require so
// nothing can capture the real home; node's test runner gives each file its own
// process, so this cannot leak into another suite.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-codex-'));
process.env.SOA_CODEX_HOME = ROOT;
const codexUsage = require('../src/codexUsage');
const { lineTs, subBuckets, normalizeLimit, nextLineStart, _reset } = codexUsage._internals;

const DAY_DIR = path.join(ROOT, 'sessions', '2026', '09', '17');
fs.mkdirSync(DAY_DIR, { recursive: true });

const iso = ms => new Date(ms).toISOString();
const usage = (n) => ({
    input_tokens: n, cached_input_tokens: Math.floor(n / 2), cache_write_input_tokens: 0,
    output_tokens: Math.floor(n / 10), reasoning_output_tokens: 0,
    total_tokens: n + Math.floor(n / 10),
});

/** A rollout file in codex's real shape: session_meta first, then records. */
function writeRollout(name, { id, cwd, model, startMs, steps, limits, pad = 0, cumStart = 0 }) {
    const lines = [];
    lines.push(JSON.stringify({
        timestamp: iso(startMs), ordinal: 0, type: 'session_meta',
        payload: {
            session_id: id, id, timestamp: iso(startMs), cwd, originator: 'codex-tui',
            cli_version: '0.154.0', model_provider: 'openai',
            base_instructions: { text: 'x', provenance: { model } },
        },
    }));
    let cum = cumStart;
    for (const [i, s] of steps.entries()) {
        cum += s.tokens;
        const ts = iso(s.at);
        if (pad) {
            // A tool result far bigger than any probe — the thing that made the
            // first version of the tail skip a whole session.
            lines.push(JSON.stringify({
                timestamp: ts, ordinal: i * 3 + 1, type: 'response_item',
                payload: { type: 'custom_tool_call_output', output: 'z'.repeat(pad) },
            }));
        }
        lines.push(JSON.stringify({
            timestamp: ts, ordinal: i * 3 + 2, type: 'token_usage_record',
            payload: {
                thread_id: id, session_id: id, usage: usage(s.tokens),
                thread_token_usage: usage(cum),
            },
        }));
        lines.push(JSON.stringify({
            timestamp: ts, ordinal: i * 3 + 3, type: 'event_msg',
            payload: {
                type: 'token_count',
                info: { total_token_usage: usage(cum), model_context_window: 258400 },
                rate_limits: limits,
            },
        }));
    }
    fs.writeFileSync(path.join(DAY_DIR, name), lines.join('\n') + '\n');
}

const LIMITS = {
    limit_id: 'codex', plan_type: 'self_serve_business_prolite',
    primary: { used_percent: 87.5, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 3600 },
    secondary: { used_percent: 20, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 600 },
    credits: { has_credits: true, unlimited: false, balance: null },
};

function clean() {
    for (const f of fs.readdirSync(DAY_DIR)) fs.unlinkSync(path.join(DAY_DIR, f));
    _reset();
}

test('codex usage: window_minutes becomes a label a human reads', () => {
    assert.equal(codexUsage.windowLabel(10080), 'WEEKLY');
    assert.equal(codexUsage.windowLabel(20160), '2-WEEK');
    assert.equal(codexUsage.windowLabel(1440), 'DAILY');
    assert.equal(codexUsage.windowLabel(300), '5H WINDOW');
    assert.equal(codexUsage.windowLabel(45), '45M WINDOW');
    assert.equal(codexUsage.windowLabel(0), 'LIMIT');
});

test('codex usage: a limit is reported as measured, and resets_at is seconds', () => {
    const at = Math.floor(Date.now() / 1000) + 7200;
    const l = normalizeLimit({ used_percent: 42.4, window_minutes: 300, resets_at: at });
    assert.equal(l.label, '5H WINDOW');
    assert.equal(l.resetsAt, at * 1000);
    assert.ok(l.remainingMs > 7000 * 1000 && l.remainingMs <= 7200 * 1000);
    assert.equal(normalizeLimit(null), null);
    assert.equal(normalizeLimit({ window_minutes: 300 }), null, 'a limit with no percentage is not a limit');
});

test('codex usage: a timestamp is read off a line without parsing it', () => {
    const line = '{"timestamp":"2026-09-17T02:44:25.354Z","ordinal":0,"type":"session_meta","payload":{}}';
    assert.equal(lineTs(line), Date.parse('2026-09-17T02:44:25.354Z'));
    assert.equal(lineTs('not a record'), 0);
    assert.equal(lineTs(''), 0);
});

test('codex usage: subtracting buckets never goes negative', () => {
    const a = { input: 10, cached: 5, cacheWrite: 0, output: 2, reasoning: 1, total: 18 };
    const b = { input: 4, cached: 9, cacheWrite: 0, output: 0, reasoning: 0, total: 6 };
    assert.deepEqual(subBuckets(a, b), { input: 6, cached: 0, cacheWrite: 0, output: 2, reasoning: 1, total: 12 });
});

test('codex usage: a live session reports its limits, model, project and totals', () => {
    clean();
    const now = Date.now();
    writeRollout('rollout-a.jsonl', {
        id: 'aaaaaaaa-1111-2222-3333-444444444444',
        cwd: '/Users/x/Desktop/whop-dev', model: 'gpt-6-astra',
        startMs: now - 60000,
        steps: [{ at: now - 50000, tokens: 1000 }, { at: now - 10000, tokens: 500 }],
        limits: LIMITS,
    });
    const d = codexUsage.snapshot();
    assert.equal(d.available, true);
    assert.equal(d.hasData, true);
    assert.equal(d.planType, 'self_serve_business_prolite');
    assert.equal(d.limits.primary.label, 'WEEKLY');
    assert.equal(d.limits.primary.usedPercent, 87.5);
    assert.equal(d.limits.secondary.label, '5H WINDOW');
    const s = d.sessions[0];
    assert.equal(s.project, 'whop-dev');
    assert.equal(s.model, 'gpt-6-astra', 'the model comes from the instruction provenance');
    assert.equal(s.total.tok, usageTotal(1500));
    assert.equal(s.today.tok, usageTotal(1500), 'a session that began today IS today');
    assert.equal(s.ctxTokens, 550, 'the context is the newest request, not the running total');
    assert.equal(s.ctxPct, 0, '550 of a 258k window rounds to nothing, and says so');
    assert.equal(d.models[0].name, 'gpt-6-astra');
});

test('codex usage: context is measured against the window codex reported', () => {
    clean();
    const now = Date.now();
    writeRollout('rollout-ctx.jsonl', {
        id: '99999999-1111-2222-3333-444444444444',
        cwd: '/Users/x/Desktop/whop-ios-dev', model: 'gpt-6-astra',
        startMs: now - 60000,
        // 200k in, 20k out on the newest request against a 258,400 window.
        steps: [{ at: now - 40000, tokens: 10 }, { at: now - 5000, tokens: 200000 }],
        limits: LIMITS,
    });
    const s = codexUsage.snapshot().sessions[0];
    assert.equal(s.ctxTokens, 220000);
    assert.equal(s.ctxPct, Math.round((220000 / 258400) * 100));
    assert.ok(s.ctxPct > 80, 'a session near its window should read as near its window');
});

function usageTotal(n) { return n + Math.floor(n / 10); }

test('codex usage: only the part after midnight counts as today', () => {
    clean();
    const now = Date.now();
    const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    const mid = midnight.getTime();
    // Starts before midnight, keeps going after it. The cumulative counter is
    // what makes this one subtraction rather than a sum over a day of records.
    writeRollout('rollout-b.jsonl', {
        id: 'bbbbbbbb-1111-2222-3333-444444444444',
        cwd: '/Users/x/Desktop/whop-ios-dev', model: 'gpt-5.6-sol',
        startMs: mid - 3 * 3600 * 1000,
        steps: [
            { at: mid - 2 * 3600 * 1000, tokens: 9000 },   // yesterday
            { at: mid - 1 * 3600 * 1000, tokens: 1000 },   // yesterday
            { at: mid + 60000, tokens: 300 },              // today
            { at: Math.min(now, mid + 120000), tokens: 200 },
        ],
        limits: LIMITS,
    });
    const s = codexUsage.snapshot().sessions[0];
    assert.equal(s.total.tok, usageTotal(10500), 'the thread total is everything');
    assert.equal(s.today.tok, usageTotal(10500) - usageTotal(10000), 'today is the part after midnight');
});

test('codex usage: a session untouched since midnight contributes nothing to today', () => {
    clean();
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const mid = midnight.getTime();
    writeRollout('rollout-c.jsonl', {
        id: 'cccccccc-1111-2222-3333-444444444444',
        cwd: '/Users/x/old', model: 'gpt-6-astra',
        startMs: mid - 5 * 3600 * 1000,
        steps: [{ at: mid - 4 * 3600 * 1000, tokens: 7777 }],
        limits: LIMITS,
    });
    fs.utimesSync(path.join(DAY_DIR, 'rollout-c.jsonl'), new Date(mid - 3600000), new Date(mid - 3600000));
    const d = codexUsage.snapshot();
    assert.equal(d.today.tokens.total, 0);
    assert.equal(d.sessions[0].total.tok, usageTotal(7777));
});

test('codex usage: a record larger than any probe does not cost the session its day', () => {
    clean();
    const now = Date.now();
    // 1.5 MB of tool output between every usage record. The first version of
    // the tail took one 32 KB probe to find a line boundary, landed inside one
    // of these, gave up, and skipped the whole file.
    writeRollout('rollout-huge.jsonl', {
        id: 'dddddddd-1111-2222-3333-444444444444',
        cwd: '/Users/x/Desktop/whop-dev', model: 'gpt-6-astra',
        startMs: now - 300000,
        steps: [
            { at: now - 240000, tokens: 4000 },
            { at: now - 120000, tokens: 4000 },
            { at: now - 30000, tokens: 4000 },
        ],
        limits: LIMITS,
        pad: 1_500_000,
    });
    const size = fs.statSync(path.join(DAY_DIR, 'rollout-huge.jsonl')).size;
    assert.ok(size > 4_000_000, 'the fixture is bigger than the initial tail window');
    const d = codexUsage.snapshot();
    assert.equal(d.sessions.length, 1);
    assert.equal(d.sessions[0].total.tok, usageTotal(12000), 'the cumulative total survives the giant records');
    assert.ok(d.today.tokens.total > 0);
});

test('codex usage: one thread split across two rollout files is not double counted', () => {
    clean();
    const now = Date.now();
    const id = 'eeeeeeee-1111-2222-3333-444444444444';
    // A resumed thread replays its history into a new file, so its cumulative
    // counter restarts from where it left off. Summing the files would bill the
    // shared history twice; the largest cumulative is the thread's real total.
    writeRollout('rollout-e1.jsonl', {
        id, cwd: '/Users/x/Desktop/whop-dev', model: 'gpt-6-astra',
        startMs: now - 400000, steps: [{ at: now - 300000, tokens: 5000 }], limits: LIMITS,
    });
    writeRollout('rollout-e2.jsonl', {
        id, cwd: '/Users/x/Desktop/whop-dev', model: 'gpt-6-astra',
        startMs: now - 200000,
        // The resumed file carries the thread's running total forward.
        cumStart: 5000,
        steps: [{ at: now - 100000, tokens: 5000 }, { at: now - 50000, tokens: 2000 }],
        limits: LIMITS,
    });
    const d = codexUsage.snapshot();
    assert.equal(d.sessions.length, 1, 'one thread, one row');
    assert.equal(d.sessions[0].total.tok, usageTotal(12000));
});

test('codex usage: the freshest rate-limit reading wins across sessions', () => {
    clean();
    const now = Date.now();
    const older = { ...LIMITS, primary: { used_percent: 10, window_minutes: 10080, resets_at: 1 } };
    const newer = { ...LIMITS, primary: { used_percent: 99, window_minutes: 10080, resets_at: 2 } };
    writeRollout('rollout-f1.jsonl', {
        id: 'ffffffff-1111-2222-3333-444444444444', cwd: '/a', model: 'm',
        startMs: now - 500000, steps: [{ at: now - 400000, tokens: 10 }], limits: older,
    });
    writeRollout('rollout-f2.jsonl', {
        id: 'ffffffff-2222-2222-3333-444444444444', cwd: '/b', model: 'm',
        startMs: now - 100000, steps: [{ at: now - 20000, tokens: 10 }], limits: newer,
    });
    // The limits describe the ACCOUNT, not the session, so every transcript
    // repeats them and only the most recent reading is current.
    assert.equal(codexUsage.snapshot().limits.primary.usedPercent, 99);
});

test('codex usage: no codex install is reported as absent, not as zero usage', () => {
    clean();
    const d = codexUsage.snapshot();
    assert.equal(d.available, false);
    assert.equal(d.hasData, false);
    assert.deepEqual(d.sessions, []);
    assert.equal(d.limits, null);
});

test('codex usage: nextLineStart walks past a record longer than a probe', () => {
    clean();
    const p = path.join(DAY_DIR, 'raw.txt');
    fs.writeFileSync(p, 'x'.repeat(3_000_000) + '\n' + 'after\n');
    const fd = fs.openSync(p, 'r');
    try {
        const size = fs.statSync(p).size;
        assert.equal(nextLineStart(fd, size, 10), 3_000_001);
        assert.equal(nextLineStart(fd, size, 3_000_001), size);
    } finally { fs.closeSync(fd); }
});

test.after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {} });

test('codex usage: the two cumulative series are never mixed in one subtraction', () => {
    clean();
    const now = Date.now();
    const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    const mid = midnight.getTime();
    const id = '77777777-1111-2222-3333-444444444444';
    // codex writes a running total twice and the two disagree — measured on a
    // real transcript, on 399 of 448 readings. Here token_count deliberately
    // trails token_usage_record, the way it does in the wild. Subtracting one
    // series' baseline from the other's total produced a day whose cached
    // input exceeded its own total, which is impossible within either.
    const mk = (ts, recCum, infoCum, recDelta, infoDelta) => ([
        JSON.stringify({
            timestamp: iso(ts), ordinal: 1, type: 'token_usage_record',
            payload: { thread_id: id, session_id: id, usage: usage(recDelta), thread_token_usage: usage(recCum) },
        }),
        JSON.stringify({
            timestamp: iso(ts), ordinal: 2, type: 'event_msg',
            payload: {
                type: 'token_count',
                info: {
                    total_token_usage: usage(infoCum), last_token_usage: usage(infoDelta),
                    model_context_window: 258400,
                },
                rate_limits: LIMITS,
            },
        }),
    ]);
    const lines = [JSON.stringify({
        timestamp: iso(mid - 3600000), ordinal: 0, type: 'session_meta',
        payload: {
            session_id: id, id, cwd: '/Users/x/Desktop/split', cli_version: '0.154.0',
            base_instructions: { provenance: { model: 'gpt-6-astra' } },
        },
    })];
    lines.push(...mk(mid - 1800000, 10000, 9000, 10000, 9000));   // before midnight
    lines.push(...mk(mid + 60000, 12000, 10500, 2000, 1500));     // first of today
    lines.push(...mk(Math.min(now, mid + 120000), 13000, 11200, 1000, 700));
    fs.writeFileSync(path.join(DAY_DIR, 'rollout-split.jsonl'), lines.join('\n') + '\n');

    const s = codexUsage.snapshot().sessions[0];
    // The record series is preferred, so today is 13000 - 10000 within it —
    // never 13000 - 9000 (mixing) and never 11200 - 10000 (mixing the other way).
    assert.equal(s.total.tok, usageTotal(13000));
    assert.equal(s.today.tok, usageTotal(13000) - usageTotal(10000));
    assert.ok(s.today.cached <= s.today.tok, 'cached input cannot exceed the total it is part of');
});

test('codex usage: seekTs lands on the first record at or after a timestamp', () => {
    clean();
    const p = path.join(DAY_DIR, 'seek.jsonl');
    const base = Date.parse('2026-09-17T00:00:00.000Z');
    const lines = [];
    const offsets = [];
    let off = 0;
    for (let i = 0; i < 400; i++) {
        // Every tenth record is a megabyte, so the binary search is forced
        // through the case where a probe contains no line boundary at all.
        const pad = i % 10 === 0 ? 'z'.repeat(1_100_000) : 'z'.repeat(200);
        const line = JSON.stringify({ timestamp: iso(base + i * 60000), ordinal: i, type: 'x', payload: { pad } });
        lines.push(line);
        offsets.push(off);
        off += Buffer.byteLength(line, 'utf8') + 1;
    }
    fs.writeFileSync(p, lines.join('\n') + '\n');
    const size = fs.statSync(p).size;
    assert.ok(size > 40_000_000, 'the fixture is far bigger than a probe');
    const fd = fs.openSync(p, 'r');
    try {
        for (const i of [0, 1, 7, 10, 123, 250, 399]) {
            assert.equal(codexUsage.seekTs(fd, size, base + i * 60000), offsets[i], `record ${i}`);
        }
        // A timestamp between two records resolves to the later one.
        assert.equal(codexUsage.seekTs(fd, size, base + 123 * 60000 + 30000), offsets[124]);
        // Before everything is the start; after everything is the end.
        assert.equal(codexUsage.seekTs(fd, size, base - 60000), 0);
        assert.equal(codexUsage.seekTs(fd, size, base + 10_000 * 60000), size);
    } finally { fs.closeSync(fd); }
});
