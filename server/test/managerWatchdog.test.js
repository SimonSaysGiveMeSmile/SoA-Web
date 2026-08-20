'use strict';
/**
 * Regression tests for the manager self-healer's parsing of `soa-sessions list`
 * (scripts/soa-manager-watchdog). The watchdog reads tab status/ctx/flags out of
 * a padded text table, which is fragile: a parse drift silently breaks HIGH-CTX
 * compaction (the cycle-1 field-index bug) or the find-by-title live-preference
 * (the manager-proliferation fix). Positional awk ($3/$5) was replaced by a
 * TAIL_RE anchored on the TRAILING columns precisely because multi-word titles
 * ("Master Chef") shifted every column; these tests run the REAL bash functions
 * against stubbed list output so that contract can't regress unnoticed.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const WD = path.resolve(__dirname, '../../scripts/soa-manager-watchdog');
const SRC = fs.readFileSync(WD, 'utf8');

// Pull a `name() { ... }` block out of the script. Two shapes exist: one-liners
// (`tab_line()   { …; }`) and multi-line blocks whose closing brace is at column 0.
function extract(name) {
    const m = SRC.match(new RegExp(`^${name}\\(\\)[ \\t]*\\{(.*\\}[ \\t]*$|[\\s\\S]*?\\n\\})`, 'm'));
    assert.ok(m, `could not extract ${name}() from ${WD}`);
    return m[0];
}
// tab_status/tab_ctx/tab_flags are one-liners over a shared regex, so the
// TAIL_RE assignment IS part of the parsing contract — pull it in too.
function extractVar(name) {
    const m = SRC.match(new RegExp(`^${name}=.*$`, 'm'));
    assert.ok(m, `could not extract ${name} from ${WD}`);
    return m[0];
}
const FUNCS = [
    extractVar('TAIL_RE'),
    ...['tab_line', 'tab_status', 'tab_ctx', 'tab_flags', 'tab_exists', 'find_by_title'].map(extract),
].join('\n');

// Sample mirrors real `soa-sessions list` output: "  #<id>  <title…20>  <status>  ctx  <pct>  [FLAGS]".
// The title column is padded and MAY CONTAIN SPACES ("Master Chef") — that is what
// broke the old positional parse. Two tabs share the title "api": #5 done (stale),
// #6 working (live). #9 has an unknown ctx ("—"). "manager-ui" is listed FIRST and
// with the lower id so a prefix match would wrongly claim it for title "manager".
const pad = (s, n) => s + ' '.repeat(Math.max(1, n - s.length));
const row = (id, title, status, ctx, flags = '') =>
    `  #${id}  ${pad(title, 20)}${pad(status, 10)}ctx  ${ctx}  ${flags}`;
const SAMPLE = [
    row(2, 'soa-web', 'working', '39%'),
    row(17, 'housing', 'done', '36%'),
    row(18, 'Summer', 'idle', '95%', 'HIGH-CTX'),
    row(5, 'api', 'done', '10%'),
    row(6, 'api', 'working', '20%'),
    row(1, 'Master Chef', 'working', '14%'),
    row(7, 'manager-ui', 'working', '12%'),
    row(8, 'manager', 'attention', '41%', 'NEEDS-INPUT'),
    row(9, 'ghost', 'idle', '—'),
    row(34, 'launchd', 'idle', '7%'),
].join('\n');

function run(calls) {
    const script = `set -u\nSESSION_LIST=$(cat <<'EOF'\n${SAMPLE}\nEOF\n)\n${FUNCS}\n${calls}`;
    return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
}

test('tab_status: the status word, even when the title has spaces', () => {
    assert.strictEqual(run('tab_status 2').trim(), 'working');
    assert.strictEqual(run('tab_status 17').trim(), 'done');
    assert.strictEqual(run('tab_status 8').trim(), 'attention');
    // "Master Chef" shifted every column under awk $3 and logged "status=Chef";
    // anchoring on the trailing "ctx <pct>" is what makes this line parse. #1 must
    // also not be satisfied by #17/#18 — the id lookup is anchored on a trailing
    // space, and #1 sits AFTER them in the list.
    assert.strictEqual(run('tab_status 1').trim(), 'working');
});

test('tab_ctx: a bare integer, NOT the literal "ctx" label and NOT "39%"', () => {
    // This is the exact cycle-1 bug: reading field 4 returned the label, so the
    // `-ge 80` test never fired and HIGH-CTX compaction never ran. The label is
    // now the regex anchor rather than a field, and the % is stripped so the
    // value is numerically comparable. Lock both halves of the contract.
    assert.strictEqual(run('tab_ctx 2').trim(), '39');
    assert.strictEqual(run('tab_ctx 18').trim(), '95');
    assert.strictEqual(run('tab_ctx 1').trim(), '14');
    // ctx prints "—" when unknown → empty, so callers can default to 0 instead
    // of exploding on `[ "—" -ge 80 ]`.
    assert.strictEqual(run('tab_ctx 9').trim(), '');
});

test('tab_ctx: drives the real HIGH-CTX compaction comparison', () => {
    // Mirrors the caller verbatim: `[ "${CTX_PCT:-0}" -ge 80 ]`. If tab_ctx ever
    // returns "ctx"/"39%"/junk again this errors or stops firing.
    const gate = (id) => run(`CTX=$(tab_ctx ${id}); [ "${'${CTX:-0}'}" -ge 80 ] && echo compact || echo skip`).trim();
    assert.strictEqual(gate(18), 'compact');
    assert.strictEqual(gate(2), 'skip');
    assert.strictEqual(gate(9), 'skip');
});

test('tab_flags: returns trailing flags (HIGH-CTX), empty when none', () => {
    assert.match(run('tab_flags 18'), /HIGH-CTX/);
    assert.match(run('tab_flags 8'), /NEEDS-INPUT/);
    assert.strictEqual(run('tab_flags 2').trim(), '');
});

test('tab_exists: true for present id, false for absent (exact id, not substring)', () => {
    const exists = (id) => run(`tab_exists ${id} && echo yes || echo no`).trim();
    assert.strictEqual(exists(2), 'yes');
    assert.strictEqual(exists(99), 'no');
    // #34 is present but #3 is NOT. This is the stored-id fallback path: a stale
    // manager-id must not look alive just because its digits prefix another tab's,
    // or the watchdog pins itself to an unrelated agent and never respawns.
    assert.strictEqual(exists(34), 'yes');
    assert.strictEqual(exists(3), 'no');
});

test('find_by_title: prefers the LIVE (non-done) duplicate, not the stale done one', () => {
    // #5 (done) appears before #6 (working); must return #6 to avoid re-selecting
    // a stale "done" tab and re-triggering the respawn path (proliferation fix).
    assert.strictEqual(run('find_by_title api').trim(), '6');
    // Single match still resolves.
    assert.strictEqual(run('find_by_title soa-web').trim(), '2');
});

test('find_by_title: exact title match — "manager" must not match "manager-ui"', () => {
    // Title is authoritative for manager identity, so a prefix match would pin the
    // watchdog to an unrelated agent's tab and leave the real manager unsupervised.
    assert.strictEqual(run('find_by_title manager').trim(), '8');
    assert.strictEqual(run('find_by_title manager-ui').trim(), '7');
});
