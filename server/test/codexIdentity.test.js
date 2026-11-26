'use strict';
// Codex identity from the rollout file a running codex holds open, and the
// soa-restart --hints-only flag the watchdog uses before killing a hung daemon.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const si = require('../src/sessionIdentity');
const { parseArgs } = require('../../scripts/soa-restart');

const R = (ts, id) => `n/Users/u/.codex/sessions/2026/11/25/rollout-${ts}-${id}.jsonl`;
const A = '01a0ebea-6fc9-76a2-a8ca-510b4191b01b';
const B = '01a1d7ff-8335-7370-8dec-dbcd938fef75';

test('parseCodexOpen maps each codex pid to the rollout it holds open', () => {
    const out = [
        'p101', 'fcwd', 'n/Users/u/Desktop', R('2026-09-28T23-46-44', A),
        'p202', 'n/dev/ttys015', R('2026-11-13T19-00-14', B.toUpperCase()),
        'p303', 'n/Users/u/.codex/log/codex-tui.log',   // no rollout: not listed
    ].join('\n');
    const m = si.parseCodexOpen(out);
    assert.deepStrictEqual([...m.keys()], [101, 202]);
    assert.deepStrictEqual(m.get(101), { agent: 'codex', sessionId: A });
    assert.strictEqual(m.get(202).sessionId, B, 'ids are lower-cased');
    assert.strictEqual(si.parseCodexOpen('').size, 0);
});

test('a process holding two rollouts is ambiguous (sub-agent threads): left out', () => {
    const m = si.parseCodexOpen(['p7', R('2026-11-25T08-00-00', A), R('2026-11-25T09-30-00', B),
        'p8', R('2026-11-25T08-00-00', A), R('2026-11-25T08-00-00', A)].join('\n'));
    assert.strictEqual(m.has(7), false);
    assert.strictEqual(m.get(8).sessionId, A, 'the same rollout listed twice is still one');
});

test('a cached sweep (argv only) never undoes a live id stamped off the same process', () => {
    const table = si.parseTable(['  60     1 /bin/zsh', `  61    60 codex resume ${A}`].join('\n'));
    const tab = { id: 3, pty: { pid: 60 }, agent: 'codex', sessionId: null };
    si.stampTabs([tab], { table, agents: si.parseCodexOpen(['p61', R('2026-11-25T10-00-00', B)].join('\n')) });
    assert.strictEqual(tab.sessionId, B, '/resume inside codex: the open rollout wins');
    const r = si.stampTabs([tab], { table, agents: null });    // the 3-in-4 sweeps without the live answer
    assert.strictEqual(r.stamped, 0);
    assert.strictEqual(tab.sessionId, B, 'argv id A must not flip it back');
    // A NEW process in the tab is a different matter: its argv is the truth.
    const t2 = si.parseTable(['  60     1 /bin/zsh', `  62    60 codex resume ${A}`].join('\n'));
    si.stampTabs([tab], { table: t2, agents: null });
    assert.strictEqual(tab.sessionId, A);
});

test('a codex-only map still says the Claude registry was unavailable', () => {
    const cx = si.parseCodexOpen(['p5', R('2026-11-25T10-00-00', A)].join('\n'));
    assert.strictEqual(si.hasClaudeRegistry(si.withCodex(null, cx)), false);
    assert.strictEqual(si.hasClaudeRegistry(si.withCodex(new Map(), cx)), true);
    assert.strictEqual(si.hasClaudeRegistry(null), false);
    assert.strictEqual(si.withCodex(null, cx).get(5).sessionId, A);
});

test('soa-restart reads every shell cwd from ONE lsof', () => {
    const { parseLsofCwds } = require('../../scripts/soa-restart');
    const m = parseLsofCwds(['p11', 'fcwd', 'n/Users/u/Desktop', 'p12', 'fcwd', 'n/Users/u/Desktop/Side-Proj/Games'].join('\n'));
    assert.deepStrictEqual([...m], [[11, '/Users/u/Desktop'], [12, '/Users/u/Desktop/Side-Proj/Games']]);
});

test('observe(): a bare codex gets its id from the open rollout; argv only as fallback', () => {
    const table = si.parseTable([
        '  50     1 /bin/zsh',
        '  51    50 codex',                                  // bare: no id in argv
        '  60     1 /bin/zsh',
        `  61    60 codex resume ${A} -c check_for_update_on_startup=false`,
        '  70     1 /bin/zsh',
        '  71    70 claude --resume aaaaaaaa-1111-2222-3333-444444444444',
    ].join('\n'));
    const reg = si.withCodex(new Map([[71, { sessionId: 'bbbbbbbb-1111-2222-3333-444444444444' }]]),
        si.parseCodexOpen(['p51', R('2026-11-13T19-00-14', B), 'p61', R('2026-11-25T10-00-00', B)].join('\n')));
    assert.deepStrictEqual(si.observe(50, table, reg), { agent: 'codex', sessionId: B, pid: 51, source: 'live' });
    // The live file wins over the id the process STARTED with (a /resume inside the TUI).
    assert.strictEqual(si.observe(60, table, reg).sessionId, B);
    assert.strictEqual(si.observe(60, table, null).sessionId, A, 'no lsof answer: argv id');
    assert.strictEqual(si.observe(70, table, reg).sessionId, 'bbbbbbbb-1111-2222-3333-444444444444');
});

test('a codex entry never stands in for a claude process (and vice versa)', () => {
    const table = si.parseTable(['  10     1 /bin/zsh', '  11    10 claude', '  20     1 /bin/zsh', '  21    20 codex'].join('\n'));
    const reg = new Map([[11, { agent: 'codex', sessionId: A }], [21, { sessionId: B }]]);
    assert.strictEqual(si.observe(10, table, reg).sessionId, null);
    assert.strictEqual(si.observe(20, table, reg).sessionId, null);
});

test('stampTabs stamps a bare codex tab from its open rollout', () => {
    const table = si.parseTable(['  50     1 /bin/zsh', '  51    50 codex'].join('\n'));
    const tab = { id: 7, pty: { pid: 50 }, agent: 'codex', sessionId: null };
    const r = si.stampTabs([tab], { table, agents: si.parseCodexOpen(['p51', R('2026-11-13T19-00-14', B)].join('\n')) });
    assert.strictEqual(r.stamped, 1);
    assert.strictEqual(tab.sessionId, B);
    assert.strictEqual(tab.sessionPid, 51);
});

test('withCodex keeps the claude map when there is nothing to add', () => {
    const c = new Map([[1, { sessionId: 'x' }]]);
    assert.strictEqual(si.withCodex(c, null), c);
    assert.strictEqual(si.withCodex(null, new Map()), null);
    assert.strictEqual(si.withCodex(null, new Map([[2, { agent: 'codex', sessionId: A }]])).size, 1);
});

test('soa-restart --hints-only parses (the watchdog runs it before a kill)', () => {
    assert.strictEqual(parseArgs(['--hints-only']).hintsOnly, true);
    assert.strictEqual(parseArgs([]).hintsOnly, false);
    assert.ok(path.isAbsolute(require.resolve('../../scripts/soa-restart')));
});
