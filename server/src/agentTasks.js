/**
 * agentTasks.js — is a tab's Claude session waiting on background subagents?
 *
 * The screen cannot answer this reliably: a turn parked on delegated work and
 * a turn that just finished render almost identically, and the old
 * ~/.claude/tasks/<sid>/*.json store this daemon used to read no longer exists
 * in current Claude Code. The session transcript is the source of truth:
 *
 *   - every background task (Task-tool agent, background Bash, workflow) is
 *     announced in a tool result carrying its output path
 *     `…/tasks/<taskId>.output`;
 *   - every stop lands back in the transcript as a `<task-notification>`
 *     user message carrying `<task-id>taskId</task-id>`.
 *
 * running = launched − notified, with the task's own output file required to
 * exist and to have been written recently — so a killed session or a missed
 * notification can never leave a tab breathing green forever.
 *
 * Reads are incremental: per transcript we remember the byte offset already
 * parsed and only read what was appended since (first sight backfills the
 * last few MB), so the 4s sampler stays cheap with a large fleet.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = process.env.SOA_WEB_CLAUDE_HOME || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const BACKFILL_BYTES = 4 * 1024 * 1024;   // first sight of a transcript: parse this much tail
const CARRY_BYTES = 512;                  // re-parse overlap so a marker split across reads still matches
const STALE_OUTPUT_MS = 15 * 60 * 1000;   // un-notified task whose output stopped moving → not "running"
const DIR_CACHE_MS = 5000;                // newest-transcript lookup cache per cwd
const MAX_TRACKED = 64;                   // transcripts tracked before the oldest state is dropped

// Claude encodes a project cwd into its folder name by replacing every
// non-alphanumeric char with '-' (same rule as sessionModel.js).
function encodeCwd(cwd) {
    return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

// Launch marker: any mention of a task output path. Notification marker: the
// task-notification's id tag. Both verified against live transcripts
// (2026-08-27); ids are the basename so the same regex covers agents
// (agent-…jsonl symlinks), background shells, and future task kinds.
const LAUNCH_RE = /([^\s"'\\]*\/tasks\/([A-Za-z0-9_-]{4,})\.output)/g;
const DONE_RE = /<task-id>\s*([A-Za-z0-9_-]{4,})\s*<\/task-id>/g;

const _dirCache = new Map();   // cwd → { at, file }
const _states = new Map();     // transcript path → { offset, carry, launched: Map(id → outPath), notified: Set }

function newestTranscript(cwd) {
    const hit = _dirCache.get(cwd);
    if (hit && Date.now() - hit.at < DIR_CACHE_MS) return hit.file;
    let file = null;
    try {
        const dir = path.join(PROJECTS_DIR, encodeCwd(cwd));
        let newest = 0;
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.jsonl') || name === 'journal.jsonl') continue;
            const full = path.join(dir, name);
            let st;
            try { st = fs.statSync(full); } catch (_) { continue; }
            if (st.isFile() && st.mtimeMs > newest) { newest = st.mtimeMs; file = full; }
        }
    } catch (_) { /* no transcripts for this cwd */ }
    _dirCache.set(cwd, { at: Date.now(), file });
    return file;
}

function _stateFor(file) {
    let st = _states.get(file);
    if (!st) {
        st = { offset: 0, carry: '', launched: new Map(), notified: new Set() };
        if (_states.size >= MAX_TRACKED) _states.delete(_states.keys().next().value);
        _states.set(file, st);
    }
    return st;
}

function _parseChunk(st, chunk) {
    let m;
    LAUNCH_RE.lastIndex = 0;
    while ((m = LAUNCH_RE.exec(chunk))) st.launched.set(m[2], m[1]);
    DONE_RE.lastIndex = 0;
    while ((m = DONE_RE.exec(chunk))) st.notified.add(m[1]);
}

function _scan(file) {
    const st = _stateFor(file);
    let size;
    try { size = fs.statSync(file).size; } catch (_) { return st; }
    if (size < st.offset) { st.offset = 0; st.carry = ''; st.launched.clear(); st.notified.clear(); }
    if (size === st.offset) return st;
    const start = st.offset === 0 ? Math.max(0, size - BACKFILL_BYTES) : st.offset;
    let fd = null;
    try {
        fd = fs.openSync(file, 'r');
        const len = size - start;
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, start);
        _parseChunk(st, st.carry + buf.toString('utf8', 0, n));
        st.carry = buf.toString('utf8', Math.max(0, n - CARRY_BYTES), n);
        st.offset = start + n;
    } catch (_) { /* transient read error — try again next sweep */ }
    finally { if (fd != null) { try { fs.closeSync(fd); } catch (_) {} } }
    return st;
}

// A launched-but-unnotified task counts as running only while its output file
// exists and was written recently. statSync follows the agent symlinks into
// the subagent transcript, so "recently written" means the subagent is alive.
function _outputAlive(outPath, now) {
    try { return now - fs.statSync(outPath).mtimeMs < STALE_OUTPUT_MS; }
    catch (_) { return false; }
}

// → { running: <count of live background tasks for this cwd's newest session> }
function runningFor(cwd) {
    if (!cwd) return { running: 0 };
    const file = newestTranscript(cwd);
    if (!file) return { running: 0 };
    const st = _scan(file);
    const now = Date.now();
    let running = 0;
    for (const [id, outPath] of st.launched) {
        if (st.notified.has(id)) continue;
        if (_outputAlive(outPath, now)) running++;
    }
    return { running };
}

function _resetForTest() { _states.clear(); _dirCache.clear(); }

module.exports = { runningFor, newestTranscript, encodeCwd, _parseChunk, _stateFor, _resetForTest, STALE_OUTPUT_MS };
