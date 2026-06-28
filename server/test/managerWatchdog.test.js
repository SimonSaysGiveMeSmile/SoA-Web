'use strict';
/**
 * Regression tests for the manager self-healer's parsing of `soa-sessions list`
 * (scripts/soa-manager-watchdog). The watchdog reads tab status/ctx/flags by awk
 * COLUMN POSITION, which is fragile: a column drift silently breaks HIGH-CTX
 * compaction (the cycle-1 field-index bug) or the find-by-title live-preference
 * (the manager-proliferation fix). These tests run the REAL bash functions
 * against stubbed list output so that contract can't regress unnoticed.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const WD = path.resolve(__dirname, '../../scripts/soa-manager-watchdog');
const SRC = fs.readFileSync(WD, 'utf8');

// Pull a `name() { ... }` block out of the script (closing brace at column 0).
function extract(name) {
    const m = SRC.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, 'm'));
    assert.ok(m, `could not extract ${name}() from ${WD}`);
    return m[0];
}
const FUNCS = ['tab_field', 'tab_flags', 'tab_exists', 'find_by_title'].map(extract).join('\n');

// Sample mirrors real `soa-sessions list` output: "  #<id>  <title>  <status>  ctx  <pct>%  [FLAGS]"
// Two tabs share the title "api": #5 done (stale), #6 working (live).
const SAMPLE = [
    '  #2  soa-web      working  ctx  39%  ',
    '  #17  housing     done     ctx  36%  ',
    '  #18  Summer      idle     ctx  95%  HIGH-CTX',
    '  #5  api          done     ctx  10%  ',
    '  #6  api          working  ctx  20%  ',
].join('\n');

function run(calls) {
    const script = `set -u\nSESSION_LIST=$(cat <<'EOF'\n${SAMPLE}\nEOF\n)\n${FUNCS}\n${calls}`;
    return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
}

test('tab_field: status is column 3', () => {
    assert.strictEqual(run('tab_field 2 3').trim(), 'working');
    assert.strictEqual(run('tab_field 17 3').trim(), 'done');
});

test('tab_field: ctx% is column 5, NOT column 4 (4 is the literal "ctx" label)', () => {
    // This is the exact cycle-1 bug: reading field 4 returned the label, so
    // HIGH-CTX compaction never fired. Lock both halves of the contract.
    assert.strictEqual(run('tab_field 2 4').trim(), 'ctx');
    assert.strictEqual(run('tab_field 2 5').trim(), '39%');
    assert.strictEqual(run('tab_field 18 5').trim(), '95%');
});

test('tab_flags: returns trailing flags (HIGH-CTX), empty when none', () => {
    assert.match(run('tab_flags 18'), /HIGH-CTX/);
    assert.strictEqual(run('tab_flags 2').trim(), '');
});

test('tab_exists: true for present id, false for absent', () => {
    assert.strictEqual(run('tab_exists 2 && echo yes || echo no').trim(), 'yes');
    assert.strictEqual(run('tab_exists 99 && echo yes || echo no').trim(), 'no');
});

test('find_by_title: prefers the LIVE (non-done) duplicate, not the stale done one', () => {
    // #5 (done) appears before #6 (working); must return #6 to avoid re-selecting
    // a stale "done" tab and re-triggering the respawn path (proliferation fix).
    assert.strictEqual(run('find_by_title api').trim(), '6');
    // Single match still resolves.
    assert.strictEqual(run('find_by_title soa-web').trim(), '2');
});
