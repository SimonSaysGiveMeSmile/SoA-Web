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

// A fleet whose ONLY tab titled "manager" is sitting at 'done' — the healthy
// state an event-loop manager reads between events. This is the list shape that
// produced the 30+ zombie tabs, so it needs its own fixture: SAMPLE always has a
// live "manager" row and therefore never exercises find_by_title's fall-back.
const DONE_MANAGER = [
    row(7, 'manager-ui', 'working', '12%'),
    row(8, 'manager', 'done', '41%'),
    row(34, 'launchd', 'idle', '7%'),
].join('\n');
// A just-spawned manager: soa-sessions prints ctx "—" while ctxPct is still null.
// NOTE the status/flag pair is deliberately artificial — it exists to prove the
// em-dash column still parses when a flag follows it, nothing more. The daemon
// cannot actually emit idle+STUCK together: sessionManager only sets `stuck` when
// status === 'working', which means every STUCK row the daemon produces reads
// 'working'. That is a real gap in the watchdog, not in this fixture: the script's
// STUCK interrupt+resume branch lives under `*)`, while 'working' is matched
// earlier by `working|idle|attention|done)`, so the documented STUCK handling is
// unreachable for any row the daemon can generate.
const FRESH_MANAGER = row(8, 'manager', 'idle', '—', 'STUCK');

function runWith(list, calls) {
    const script = `set -u\nSESSION_LIST=$(cat <<'EOF'\n${list}\nEOF\n)\n${FUNCS}\n${calls}`;
    return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
}
const run = (calls) => runWith(SAMPLE, calls);

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

test('tab_ctx: "—" is an unknown pct, NOT an unparseable row', () => {
    // The empty above must mean "pct unknown", not "the row fell out of TAIL_RE".
    // soa-sessions prints "—" whenever ctxPct is null (e.g. right after a spawn),
    // so if the em-dash alternative leaves TAIL_RE the WHOLE row stops matching:
    // STATUS comes back empty, the watchdog takes its `"") … returned empty status
    // — skipping` branch, and every action for that tab silently stops. Assert the
    // other trailing fields of the same row so that alternative is load-bearing.
    assert.strictEqual(run('tab_status 9').trim(), 'idle');
    // CAVEAT, so nobody reads more into the next two assertions than is there:
    // FUNCS extracts TAIL_RE and the tab_*/find_by_title helpers only — never the
    // script's `case "${STATUS:-}"` block. So these re-state the caller's SHAPE to
    // show the parsed value survives being fed to it; they do NOT execute the real
    // dispatch, and renaming a branch there would not fail this file. What they
    // genuinely pin is that an em-dash row yields a usable status and flags at all
    // (both go red the moment the em-dash leaves TAIL_RE), which is the bug this
    // test exists for. Covering the dispatch itself needs the case block extracted
    // the way FUNCS extracts the helpers.
    assert.strictEqual(
        run('S="$(tab_status 9)"; case "${S:-}" in "") echo skipping;; *) echo "act:$S";; esac').trim(),
        'act:idle');
    assert.strictEqual(
        runWith(FRESH_MANAGER, 'F="$(tab_flags 8)"; echo "$F" | grep -q STUCK && echo interrupt || echo no-action').trim(),
        'interrupt');
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

test('find_by_title: still returns a DONE-only match (the anti-duplicate guard needs it)', () => {
    // #17 "housing" is done AND unique, so this is the only case that reaches the
    // `echo "${live:-$any}"` fall-back — the other find_by_title tests all have a
    // live match to prefer. Preferring live must not mean DISCARDING done.
    assert.strictEqual(run('find_by_title housing').trim(), '17');
    // Why it matters, verbatim from spawn_manager's guard: 'done' is a healthy
    // alive state (a manager at its input box between events). If find_by_title
    // printed nothing for a done-only manager the guard would go blind and spawn a
    // SECOND manager beside a perfectly healthy one — the 30+ zombie "manager"
    // tabs (#21–#52) outage.
    const guard = (list) =>
        runWith(list, 'E="$(find_by_title manager)"; [ -n "$E" ] && echo "refuse #$E" || echo spawn').trim();
    assert.strictEqual(guard(DONE_MANAGER), 'refuse #8');
    // Control: with no "manager" row at all, MISSING is the one path that may spawn.
    assert.strictEqual(guard(row(7, 'manager-ui', 'working', '12%')), 'spawn');
});

test('find_by_title: exact title match — "manager" must not match "manager-ui"', () => {
    // Title is authoritative for manager identity, so a prefix match would pin the
    // watchdog to an unrelated agent's tab and leave the real manager unsupervised.
    assert.strictEqual(run('find_by_title manager').trim(), '8');
    assert.strictEqual(run('find_by_title manager-ui').trim(), '7');
});
