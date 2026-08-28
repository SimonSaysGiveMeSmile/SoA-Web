// The delegating detector: running = launched − notified, verified against the
// task's own output file. Markers were captured from live 2026-08-27
// transcripts: launches carry `…/tasks/<id>.output`, stops arrive as
// `<task-notification>…<task-id>id</task-id>`. The old ~/.claude/tasks store
// this daemon once read no longer exists — these tests pin the current truth.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = path.join(os.tmpdir(), `soa-web-agenttasks-test-${process.pid}`);
process.env.SOA_WEB_CLAUDE_HOME = TMP;

const agentTasks = require('../src/agentTasks');

const CWD = '/tmp/proj';
const PROJ = path.join(TMP, 'projects', agentTasks.encodeCwd(CWD));
const OUT = path.join(TMP, 'outputs', 'tasks');

function reset() {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(PROJ, { recursive: true });
    fs.mkdirSync(OUT, { recursive: true });
    agentTasks._resetForTest();
}
function outPath(id) { return path.join(OUT, `${id}.output`); }
function launchLine(id) {
    fs.writeFileSync(outPath(id), 'x');
    return JSON.stringify({ type: 'user', message: { content: `Async agent launched successfully.\noutput_file: ${outPath(id)}\nDo NOT read this file.` } }) + '\n';
}
function noticeLine(id) {
    return JSON.stringify({ type: 'user', message: { content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>` } }) + '\n';
}
const J = () => path.join(PROJ, 'session-1.jsonl');

test('launched task counts as running until its notification arrives (incremental reads)', () => {
    reset();
    fs.writeFileSync(J(), launchLine('agenta11'));
    assert.equal(agentTasks.runningFor(CWD).running, 1);
    fs.appendFileSync(J(), noticeLine('agenta11'));
    assert.equal(agentTasks.runningFor(CWD).running, 0, 'notification appended after the first scan still clears it');
});

test('several tasks: only the un-notified ones count', () => {
    reset();
    fs.writeFileSync(J(), launchLine('one11') + launchLine('two22') + noticeLine('one11') + launchLine('three3'));
    assert.equal(agentTasks.runningFor(CWD).running, 2);
});

test('a task whose output file is gone or stale never counts (killed session self-heals)', () => {
    reset();
    fs.writeFileSync(J(), launchLine('gone11') + launchLine('stale1'));
    fs.rmSync(outPath('gone11'));
    const old = (Date.now() - agentTasks.STALE_OUTPUT_MS - 60000) / 1000;
    fs.utimesSync(outPath('stale1'), old, old);
    assert.equal(agentTasks.runningFor(CWD).running, 0);
});

test('a marker split across two appended reads is still matched (carry buffer)', () => {
    reset();
    const line = launchLine('split99');
    const cut = line.indexOf('split99') + 3; // slice mid-id
    fs.writeFileSync(J(), line.slice(0, cut));
    agentTasks.runningFor(CWD);
    fs.appendFileSync(J(), line.slice(cut));
    assert.equal(agentTasks.runningFor(CWD).running, 1);
});

test('only the NEWEST transcript for a cwd is consulted', () => {
    reset();
    fs.writeFileSync(J(), launchLine('oldrun'));
    assert.equal(agentTasks.runningFor(CWD).running, 1);
    agentTasks._resetForTest(); // drop the 5s newest-file cache
    const j2 = path.join(PROJ, 'session-2.jsonl');
    fs.writeFileSync(j2, JSON.stringify({ type: 'user', message: { content: 'fresh session, no tasks' } }) + '\n');
    const future = (Date.now() + 5000) / 1000;
    fs.utimesSync(j2, future, future);
    assert.equal(agentTasks.runningFor(CWD).running, 0);
});

test('no transcripts / unknown cwd → 0, never a throw', () => {
    reset();
    assert.equal(agentTasks.runningFor('/nowhere/at/all').running, 0);
    assert.equal(agentTasks.runningFor('').running, 0);
    assert.equal(agentTasks.runningFor(null).running, 0);
});

test('a truncated/rotated transcript resets cleanly instead of mixing state', () => {
    reset();
    fs.writeFileSync(J(), launchLine('trunc1'));
    assert.equal(agentTasks.runningFor(CWD).running, 1);
    fs.writeFileSync(J(), noticeLine('other0')); // smaller file, unrelated content
    assert.equal(agentTasks.runningFor(CWD).running, 0);
});
