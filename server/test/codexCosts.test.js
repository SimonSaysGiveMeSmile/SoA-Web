const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { CostIndex, CodexCosts, price } = require('../src/codexCosts');
const { normalize, CodexQuota } = require('../src/codexQuota');
const { start } = require('../src/usageQuota');
const NOW = new Date(2026, 9, 5, 12).getTime(), HOUR = 3600000;
const U = { input_tokens: 100000, cached_input_tokens: 50000, cache_write_input_tokens: 10000,
    output_tokens: 1000, reasoning_output_tokens: 700, total_tokens: 101000 };
const row = (type, payload, ts = NOW) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type, payload }) + '\n';
const meta = (model = 'gpt-6-astra') => row('session_meta', { id: 'thread-1', base_instructions: { provenance: { model } } });
const usage = (id, ts = NOW, extra = {}) => row('token_usage_record', { response_id: id, usage: U, ...extra }, ts);
function fixture(t, text = '') {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-costs-'));
    fs.mkdirSync(path.join(home, 'sessions'));
    const file = path.join(home, 'sessions/rollout.jsonl'); fs.writeFileSync(file, text);
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    return { home, file, index: new CostIndex({ home }) };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test('published rates account for cache subsets and include reasoning only once', () => {
    near(price('gpt-6-astra', U), .625);
    near(price('gpt-6-luna', U), .00625);
    near(price('gpt-6-sol', U), .125);
    near(price('gpt-6.1-sol', U), .12);
    near(price('gpt-6-astra-2026-08-01', U), .625);
    near(price('gpt-5.3-codex', U), .11025);
    assert.equal(price('unpublished-model', U), null);
    assert.equal(price('gpt-6-astra', { ...U, cached_input_tokens: 200000 }), null);
    assert.equal(price('gpt-6-astra', { ...U, input_tokens: NaN }), null);
    assert.equal(price('gpt-6-astra', {}), null);
});

test('long-context pricing applies to the whole request only above 272K input', () => {
    near(price('gpt-6-astra', { ...U, input_tokens: 272000, cached_input_tokens: 0, cache_write_input_tokens: 0 }), 2.77);
    near(price('gpt-6-astra', { ...U, input_tokens: 272001, cached_input_tokens: 0, cache_write_input_tokens: 0 }), 5.51502);
});

test('5h, local midnight and rolling 7d have separate inclusive boundaries; future events excluded', t => {
    const cut = NOW - 7 * 24 * HOUR;
    const { index } = fixture(t, meta() + usage('outside', cut - 1) + usage('week-boundary', cut) +
        usage('yesterday', NOW - 13 * HOUR) + usage('midnight', NOW - 12 * HOUR) +
        usage('before-block', NOW - 5 * HOUR - 1) + usage('block-boundary', NOW - 5 * HOUR) + usage('now') + usage('future', NOW + 1));
    const s = index.scan(NOW);
    near(s.windows.block.cost, 2 * .625);
    near(s.windows.today.cost, 4 * .625);
    near(s.windows.week.cost, 6 * .625);
    assert.equal(s.blockBasis, 'rolling-5h');
    const q = index.scan(NOW, { windowMinutes: 300, resetsAt: NOW + 4 * HOUR, updatedAt: NOW });
    assert.equal(q.blockBasis, 'quota-window'); near(q.windows.block.cost, .625);
    assert.equal(index.scan(NOW, { windowMinutes: 300, resetsAt: NOW - 1, updatedAt: NOW }).blockBasis, 'rolling-5h');
    assert.equal(index.scan(NOW, { windowMinutes: 300, resetsAt: NOW + HOUR, updatedAt: NOW - 70000 }).blockBasis, 'rolling-5h');
    // With no appends, both the rolling window and local day still roll over.
    assert.equal(index.scan(NOW + 24 * HOUR).windows.today.cost, 0);
});

test('turn IDs price interleaved models correctly, including model switches', t => {
    const { index } = fixture(t, meta() + row('turn_context', { turn_id: 'a', model: 'gpt-6-astra' }) +
        row('turn_context', { turn_id: 'b', model: 'gpt-6-luna' }) + usage('a', NOW, { turn_id: 'a' }) + usage('b', NOW, { turn_id: 'b' }));
    near(index.scan(NOW).windows.today.cost, .63125);
});

test('response IDs deduplicate mirrored/resumed/archive records, not legitimate new responses', t => {
    const { home, file, index } = fixture(t, meta() + usage('first') + usage('first') + usage('second'));
    fs.mkdirSync(path.join(home, 'archived_sessions')); fs.copyFileSync(file, path.join(home, 'archived_sessions/mirror.jsonl'));
    const s = index.scan(NOW); assert.equal(s.windows.week.requests, 2); near(s.windows.week.cost, 1.25);
    fs.unlinkSync(file); near(index.scan(NOW).windows.week.cost, 1.25);
});

test('append and split-line polling count each response exactly once; truncation resets cached records', t => {
    const next = usage('second'), half = Math.floor(next.length / 2);
    const { file, index } = fixture(t, meta() + usage('first') + next.slice(0, half));
    near(index.scan(NOW).windows.week.cost, .625);
    fs.appendFileSync(file, next.slice(half)); near(index.scan(NOW).windows.week.cost, 1.25);
    near(index.scan(NOW).windows.week.cost, 1.25);
    fs.writeFileSync(file, meta('gpt-6-luna') + usage('replacement'));
    near(index.scan(NOW).windows.week.cost, .00625);
});

test('legacy token_count uses each delta once and is ignored when per-response records exist', t => {
    const event = (n, ts = NOW) => row('event_msg', { type: 'token_count', info: { last_token_usage: U,
        total_token_usage: { ...U, total_tokens: n * U.total_tokens } } }, ts);
    const { file, index } = fixture(t, meta() + event(1) + event(1) + event(2));
    near(index.scan(NOW).windows.week.cost, 1.25);
    fs.appendFileSync(file, usage('response')); near(index.scan(NOW).windows.week.cost, .625);
});

test('unknown models preserve coverage and never turn into a fabricated zero cost', t => {
    const { file, index } = fixture(t, meta('private-model') + usage('unknown'));
    let s = index.scan(NOW); assert.equal(s.windows.week.cost, null); assert.equal(s.windows.week.unpriced, 1);
    fs.appendFileSync(file, row('turn_context', { model: 'gpt-6-astra' }) + usage('known'));
    s = index.scan(NOW); near(s.windows.week.cost, .625); assert.equal(s.windows.week.partial, true);
    assert.equal(s.windows.week.requests, 2);
});

test('giant tool payloads are skipped without losing the following usage record or blocking partial lines', t => {
    const { index } = fixture(t, meta() + row('response_item', { output: 'x'.repeat(5 * 1024 * 1024) }) + usage('after'));
    const s = index.scan(NOW); near(s.windows.week.cost, .625); assert.equal(s.unreadableFiles, 0);
});

test('missing history is unavailable, empty readable history is a measured zero', t => {
    const { home, index } = fixture(t);
    assert.equal(index.scan(NOW).windows.week.cost, 0);
    fs.rmSync(path.join(home, 'sessions'), { recursive: true });
    assert.equal(index.scan(NOW).windows.week.cost, null);
    assert.equal(index.scan(NOW).status, 'unavailable');
});

test('worker refresh is nonblocking, tails real additions and exposes staleness', async t => {
    const { home, file } = fixture(t, meta() + usage('first'));
    let now = NOW;
    const costs = new CodexCosts({ home, now: () => now }); t.after(() => costs.close());
    assert.equal(costs.snapshot().status, 'indexing');
    costs.refresh(); await once(costs.worker, 'message');
    near(costs.snapshot().windows.today.cost, .625);
    fs.appendFileSync(file, usage('second')); costs.refresh(); await once(costs.worker, 'message');
    near(costs.snapshot().windows.today.cost, 1.25);
    now += 16000; assert.equal(costs.snapshot().status, 'stale');
});

test('official Codex windows use duration, support secondary 5h, and never substitute weekly for missing 5h', () => {
    const five = { usedPercent: 12, windowDurationMins: 300, resetsAt: (NOW + HOUR) / 1000 };
    const week = { usedPercent: 35, windowDurationMins: 10080, resetsAt: (NOW + 24 * HOUR) / 1000 };
    const s = normalize({ rateLimits: { primary: week, secondary: five } }, NOW);
    assert.equal(s.windows.session.usedPercent, 12); assert.equal(s.windows.weekly.usedPercent, 35);
    const onlyWeek = normalize({ rateLimits: { primary: five }, rateLimitsByLimitId: { codex: { primary: week } } }, NOW);
    assert.equal(onlyWeek.windows.session, null); assert.equal(onlyWeek.windowStatus.session, 'not-reported');
    const noReset = normalize({ rateLimits: { primary: { ...five, resetsAt: null } } }, NOW);
    assert.equal(noReset.windows.session.usedPercent, 12); assert.equal(noReset.windows.session.resetsAt, null);
    const expired = normalize({ rateLimits: { primary: { ...five, resetsAt: (NOW - 1) / 1000 } } }, NOW);
    assert.equal(expired.windows.session, null); assert.equal(expired.windowStatus.session, 'expired');
    assert.throws(() => normalize({ rateLimits: { limitId: 'other', primary: five } }, NOW));
    const q = new CodexQuota({ now: () => NOW + 61000 }); q.current = s;
    assert.equal(q.snapshot(false).status, 'stale'); q.close();
});

test('quota sidecar returns costs without altering quota, disables caching and closes the collector', async t => {
    let closed = false, refreshed = 0;
    const window = { usedPercent: 12, windowMinutes: 300, updatedAt: Date.now(), resetsAt: Date.now() + HOUR };
    const reader = { snapshot: () => ({ available: true, status: 'ready', windows: { session: window, weekly: null } }) };
    const costs = { snapshot: () => ({ status: 'ready', windows: { block: { cost: 1.25 } } }),
        refresh: s => { assert.equal(s, window); refreshed++; }, close: () => { closed = true; } };
    const server = start({ port: 0, providers: { claude: reader, codex: reader }, costs });
    t.after(() => server.close()); await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/api/usage-quota`;
    const res = await fetch(url); const body = await res.json();
    assert.equal(res.headers.get('cache-control'), 'no-store'); assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(body.data.codex.windows.session.usedPercent, 12); assert.equal(body.costs.codex.windows.block.cost, 1.25);
    assert.ok(refreshed > 0); assert.equal((await fetch(url, { method: 'POST' })).status, 404);
    await new Promise(resolve => server.close(resolve)); assert.equal(closed, true);
});
