/**
 * Observe which conversation each tab is ACTUALLY attached to.
 *
 * `launchClaude` stamps `tab.sessionId` for the tabs IT starts, but that is only
 * one of the ways an agent comes to live in a tab: the user types `claude
 * --resume <id>` by hand, a tab is re-attached after a crash, Claude Code is
 * restarted inside an existing shell. Any of those leaves the tab with no
 * recorded identity, and a tab with no identity is re-guessed from its cwd on
 * the next restart — which is how several tabs sharing a directory ended up
 * resuming each other's threads.
 *
 * So identity is also *observed*, not only remembered: the running agent
 * carries its own session id in its command line (`claude --resume <uuid>`,
 * `codex resume <uuid>`), so one `ps` sweep recovers it for the whole fleet.
 *
 * Deliberately EXACT-ONLY. The tempting fallback — "the newest transcript in
 * this tab's cwd" — is a guess, and a guess written into `tab.sessionId` is
 * worse than no id at all: a missing id falls back to the allocator, which
 * knows to skip threads other tabs already own, while a wrong id is treated as
 * identity and silently resumed forever. We stamp what the process tells us and
 * nothing else.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const UUID = '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})';
// `claude --resume <id>` / `claude -r <id>`, and `codex resume <id>`. `--last`
// and a bare `resume` carry no id and correctly yield nothing.
const CLAUDE_RE = new RegExp('(?:--resume|-r)\\s+' + UUID);
const CODEX_RE = new RegExp('resume\\s+' + UUID);
const HEADLESS_RE = /(?:^|\s)(?:-p|--print|--output-format|--input-format|--sdk-url)(?:\s|=|$)/;

/** One `ps` for the whole sweep: pid -> {ppid, cmd}, plus a children index. */
function processTable() {
    let out;
    try {
        out = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,command='], {
            encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 5000,
        });
    } catch (_) {
        return null;
    }
    const procs = new Map();
    const kids = new Map();
    for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const pid = +m[1], ppid = +m[2], cmd = m[3];
        procs.set(pid, { ppid, cmd });
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push(pid);
    }
    return { procs, kids };
}

/** Every descendant of `pid`, breadth-first, depth-capped against cycles. */
function descendants(pid, kids, limit = 400) {
    const out = [];
    const queue = [pid];
    const seen = new Set([pid]);
    while (queue.length && out.length < limit) {
        const cur = queue.shift();
        for (const k of kids.get(cur) || []) {
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(k);
            queue.push(k);
        }
    }
    return out;
}

/** The session id an agent command line is advertising, if any. */
function idFromCommand(cmd) {
    if (!cmd) return null;
    // The agent's own argv, not a wrapper's: `grep claude --resume x` must not
    // read as an agent, and neither must our own launcher shell's `-c "claude
    // --resume x || claude"` (that one is the shell, whose child we will see).
    const argv0 = cmd.split(/\s+/)[0] || '';
    const base = argv0.replace(/^.*\//, '');
    // Claude Code sets its own process title, and some builds title it
    // "Claude" — compare case-insensitively or that tab reads as agent-less.
    if (base.toLowerCase() === 'claude') {
        // Headless runs (`claude -p`, Agent SDK hosts) are someone's tool, not
        // the tab's conversation — and the registry lists them as
        // "interactive" with real ids, so they must be rejected here.
        if (HEADLESS_RE.test(cmd) || /claude_agent_sdk\//.test(cmd)) return null;
        const m = CLAUDE_RE.exec(cmd);
        return m ? { agent: 'claude', sessionId: m[1] } : { agent: 'claude', sessionId: null };
    }
    if (base === 'codex') {
        // The app-server daemon and code-mode host are infrastructure, not a
        // conversation.
        if (/app-server|code-mode/.test(cmd)) return null;
        const m = CODEX_RE.exec(cmd);
        return m ? { agent: 'codex', sessionId: m[1] } : { agent: 'codex', sessionId: null };
    }
    return null;
}

/**
 * Claude Code's own registry of live sessions (`claude agents --json`): pid ->
 * {sessionId, status}. This is the source that makes Claude identity exact.
 * Claude rewrites its process title to a bare `claude`, so the command line
 * carries no `--resume <id>` to read — and even when it did, the id there is
 * the one it STARTED with, which goes stale the moment the user runs /clear or
 * /resume inside the TUI. The registry reports the conversation the process is
 * in right now.
 */
function parseAgents(json) {
    const map = new Map();
    let list;
    try { list = typeof json === 'string' ? JSON.parse(json) : json; } catch (_) { return map; }
    if (!Array.isArray(list)) return map;
    for (const a of list) {
        if (!a || !Number.isInteger(a.pid) || typeof a.sessionId !== 'string') continue;
        if (!new RegExp('^' + UUID + '$').test(a.sessionId)) continue;
        map.set(a.pid, { sessionId: a.sessionId, status: a.status || null });
    }
    return map;
}

function claudeBin() {
    // launchd's PATH rarely includes the per-user install, so look where the
    // installer puts it before falling back to PATH.
    const cands = [process.env.SOA_WEB_CLAUDE_BIN, path.join(os.homedir(), '.local', 'bin', 'claude'),
        '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
    for (const p of cands) {
        if (!p) continue;
        try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) {}
    }
    return 'claude';
}

/** Async (never blocks the event loop): cb(Map|null). null = registry unavailable. */
function claudeAgents(cb) {
    if (process.env.SOA_WEB_CLAUDE_AGENTS === '0') { cb(null); return; }
    try {
        execFile(claudeBin(), ['agents', '--json'], { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout) => cb(err ? null : parseAgents(stdout)));
    } catch (_) {
        cb(null);
    }
}

/**
 * What agent (and which thread) is live under this pty. `sessionId` is null for
 * an agent that was started without one — still useful, because it tells the
 * caller the tab holds a `claude` vs a `codex`.
 */
function observe(ptyPid, table, agents) {
    if (!ptyPid || !table) return null;
    // Breadth-first, and we take the FIRST agent we meet — the shallowest one
    // under the shell is the tab's own agent. Reaching deeper for "an id rather
    // than none" would let a nested SDK subagent (`claude --resume <its own>`)
    // donate its thread to the tab, which is the very confusion this module
    // exists to prevent.
    for (const pid of descendants(ptyPid, table.kids)) {
        const hit = idFromCommand((table.procs.get(pid) || {}).cmd);
        if (!hit) continue;
        // The registry's id is the live conversation; the argv's is only
        // where the process started. Prefer the registry whenever it knows.
        const reg = hit.agent === 'claude' && agents ? agents.get(pid) : null;
        return reg ? { ...hit, sessionId: reg.sessionId } : hit;
    }
    return null;
}

/**
 * Stamp observed identity onto live tabs. Returns what changed, so the caller
 * can decide whether the persist is worth doing.
 *
 * The live process WINS over a remembered id, because it is the only thing that
 * is true right now: a tab can legitimately be re-pointed at another thread by
 * hand (`claude --resume <other>`), and keeping the older stamp would resume the
 * conversation the tab has already left. What we never do is CLEAR — an agent
 * that has exited leaves the tab still knowing where it was, which is exactly
 * what the next resume needs.
 */
function stampTabs(tabs, { table, agents: registry } = {}) {
    const t = table || processTable();
    if (!t) return { stamped: 0, agents: 0 };
    let stamped = 0, agents = 0;
    for (const tab of tabs || []) {
        if (!tab || tab.exited) continue;
        const pid = tab.pty && tab.pty.pid;
        if (!pid) continue;
        const seen = observe(pid, t, registry);
        if (!seen) continue;
        if (seen.agent && tab.agent !== seen.agent) {
            // A different agent kind: the remembered id belongs to the old one
            // (`codex resume <claude id>` would fail), so drop it.
            tab.agent = seen.agent;
            tab.sessionId = null;
            agents++;
        }
        if (seen.sessionId && tab.sessionId !== seen.sessionId) {
            tab.sessionId = seen.sessionId;
            stamped++;
        }
    }
    return { stamped, agents };
}

/**
 * One-shot hints for the restart itself. A daemon running code older than the
 * registry lookup flushes its (possibly stale) remembered ids on shutdown, so
 * the restart that installs this fix would still resume the wrong threads.
 * `soa-agents hints` writes the LIVE ids just before the restart; boot applies
 * them here, then retires the file so it can never override a later run.
 *
 * Matching is by position in the saved tab order, confirmed by cwd; a hint
 * whose cwd disagrees is used only when that cwd is unique on both sides.
 * Anything ambiguous is skipped — a missing id falls back to the allocator,
 * a wrong one would be resumed forever.
 */
const HINTS_MAX_AGE_MS = 30 * 60 * 1000;
function hintsPath(stateDir) { return path.join(stateDir, 'session-hints.json'); }

function applyHints(entries, stateDir, { now = Date.now(), maxAgeMs = HINTS_MAX_AGE_MS } = {}) {
    const file = hintsPath(stateDir);
    let hints;
    try { hints = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return { applied: 0, reason: 'none' }; }
    // Retire it whatever happens next: a hint is only ever good for one boot.
    try { fs.renameSync(file, file + '.applied'); } catch (_) {}
    if (!hints || !Array.isArray(hints.tabs) || !Array.isArray(entries)) return { applied: 0, reason: 'malformed' };
    if (!Number.isFinite(hints.savedAt) || now - hints.savedAt > maxAgeMs || hints.savedAt > now + 60000) {
        return { applied: 0, reason: 'stale' };
    }
    const valid = h => h && typeof h.cwd === 'string' && typeof h.sessionId === 'string'
        && new RegExp('^' + UUID + '$').test(h.sessionId);
    const used = new Set();
    let applied = 0;
    const set = (entry, sid) => {
        if (entry.agent && entry.agent !== 'claude') return;   // claude ids only
        // Hint ids come only from `claude agents`, so the tab is a claude tab;
        // an unset agent would let auto-resume guess codex from mtimes.
        if (!entry.agent) entry.agent = 'claude';
        if (entry.sessionId !== sid) { entry.sessionId = sid; applied++; }
    };
    entries.forEach((entry, i) => {
        const h = hints.tabs[i];
        if (entry && valid(h) && h.cwd === entry.cwd) { set(entry, h.sessionId); used.add(i); }
    });
    entries.forEach((entry, i) => {
        if (!entry || (valid(hints.tabs[i]) && hints.tabs[i].cwd === entry.cwd)) return;
        const live = entries.filter(e => e && e.cwd === entry.cwd);
        const cand = hints.tabs.map((h, j) => [h, j]).filter(([h, j]) => valid(h) && h.cwd === entry.cwd && !used.has(j));
        if (live.length === 1 && cand.length === 1) { set(entry, cand[0][0].sessionId); used.add(cand[0][1]); }
    });
    return { applied, reason: 'ok' };
}

module.exports = { processTable, descendants, idFromCommand, observe, stampTabs, parseAgents, claudeAgents, applyHints, hintsPath };
