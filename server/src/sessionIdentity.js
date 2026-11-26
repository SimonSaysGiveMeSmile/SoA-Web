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

const PS_ARGS = ['-ax', '-o', 'pid=,ppid=,command='];
const PS_OPTS = { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 5000 };

/**
 * One `ps` for the whole sweep: pid -> {ppid, cmd}, plus a children index.
 * SYNCHRONOUS — for shutdown/crash flushes only, where the PTYs are about to
 * die and there is no later tick to wait for. A fleet with its MCP children is
 * a thousand processes, and a full-argv `ps` that size on the event loop every
 * sweep stalls every terminal; the periodic paths use processTableAsync.
 */
function processTable() {
    let out;
    try { out = execFileSync('ps', PS_ARGS, PS_OPTS); } catch (_) { return null; }
    return parseTable(out);
}

/** The same table without blocking the event loop: cb(table|null). */
function processTableAsync(cb) {
    try {
        execFile('ps', PS_ARGS, PS_OPTS, (err, out) => cb(err ? null : parseTable(out)));
    } catch (_) {
        cb(null);
    }
}

function parseTable(out) {
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

// The last registry answer, for a sweep between registry refreshes. It goes
// stale: after REGISTRY_MAX_AGE_MS it is not an answer any more (a registry
// that keeps failing must not keep vouching for pids from an hour ago).
const REGISTRY_MAX_AGE_MS = 10 * 60 * 1000;
let _lastAgents = null;
let _lastAgentsAt = 0;
function cachedAgents({ now = Date.now(), maxAgeMs = REGISTRY_MAX_AGE_MS } = {}) {
    return _lastAgents && now - _lastAgentsAt <= maxAgeMs ? _lastAgents : null;
}
function _remember(map) { if (map) { _lastAgents = map; _lastAgentsAt = Date.now(); } return map; }

/** Async (never blocks the event loop): cb(Map|null). null = registry unavailable. */
function claudeAgents(cb) {
    if (process.env.SOA_WEB_CLAUDE_AGENTS === '0') { cb(null); return; }
    try {
        execFile(claudeBin(), ['agents', '--json'], { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout) => {
                cb(_remember(err ? null : parseAgents(stdout)));
            });
    } catch (_) {
        cb(null);
    }
}

/**
 * The registry NOW, synchronously — for shutdown and crash flushes. A thread
 * switch (/resume, /clear) in the last couple of minutes is only in a fresh
 * answer; the cached one would persist the conversation the user just left.
 * Bounded (~3 s), and null on failure so the caller falls back to the cache.
 */
function claudeAgentsSync(timeoutMs = 3000) {
    if (process.env.SOA_WEB_CLAUDE_AGENTS === '0') return null;
    try {
        const out = execFileSync(claudeBin(), ['agents', '--json'], {
            encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
        });
        return _remember(parseAgents(out));
    } catch (_) {
        return null;
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
        return reg ? { ...hit, sessionId: reg.sessionId, pid } : { ...hit, pid };
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
 * conversation the tab has already left. An agent that has EXITED clears
 * nothing — the tab still knowing where it was is exactly what the next resume
 * needs.
 *
 * `tab.sessionPid` is the process the id belongs to: the pid it was read off,
 * or 'launched' while a launch of ours has not been seen yet (its id is the
 * one we typed). A DIFFERENT process of the same kind with no readable id is a
 * new agent — a bare `claude` started by hand, a fresh `codex` — and keeping
 * the old id would resume the thread the user left, so the id is cleared and
 * the tab goes back to the allocator.
 */
function stampTabs(tabs, { table, agents: registry, resolveCwd = null } = {}) {
    const t = table || processTable();
    if (!t) return { stamped: 0, agents: 0 };
    let stamped = 0, agents = 0;
    for (const tab of tabs || []) {
        if (!tab || tab.exited) continue;
        const pid = tab.pty && tab.pty.pid;
        if (!pid) continue;
        const seen = observe(pid, t, registry);
        if (!seen) continue;
        // Seen running, so the paint detector no longer gets to relabel it.
        tab.agentObserved = true;
        if (seen.agent && tab.agent !== seen.agent) {
            // A different agent kind: the remembered id belongs to the old one
            // (`codex resume <claude id>` would fail), so drop it.
            tab.agent = seen.agent;
            tab.sessionId = null;
            tab.sessionCwd = null;
            tab.sessionPid = null;
            agents++;
        }
        if (seen.sessionId) {
            if (tab.sessionId !== seen.sessionId) {
                tab.sessionId = seen.sessionId;
                // A new thread has its own home directory; the old one's is
                // wrong now. Looked up here only when the caller asks (it walks
                // the transcript dirs); otherwise the next launch resolves it.
                let home = null;
                if (resolveCwd) { try { home = resolveCwd(seen.agent, seen.sessionId) || null; } catch (_) {} }
                tab.sessionCwd = home;
                stamped++;
            }
            tab.sessionPid = seen.pid;
        } else if (tab.sessionId) {
            if (tab.sessionPid === 'launched') tab.sessionPid = seen.pid;   // our launch: the id is the one we typed
            else if (tab.sessionPid !== seen.pid) {
                tab.sessionId = null; tab.sessionCwd = null; tab.sessionPid = null;
                stamped++;
            }
        }
    }
    return { stamped, agents };
}

/**
 * Compare what a restore MEANT to attach to each tab with what is actually
 * running there. `expected` is `tab.restoreExpect` (written by the restore
 * paths at launch, so a later sweep cannot overwrite it) or, for a tab no
 * restore touched, its remembered identity.
 *
 * Status per tab:
 *   ok             the expected agent is running on the expected thread
 *   wrong-agent    a claude where a codex should be, or vice versa
 *   wrong-session  the right agent on another thread
 *   missing        a thread was expected but nothing is running (the resume
 *                  failed and left the shell)
 *   unverified     the right agent, but its thread is not readable (Claude's
 *                  bare process title and no registry answer)
 *   shell          nothing expected, nothing running
 * plus `duplicates`: one observed thread live in more than one tab — several
 * writers on one transcript, the failure this whole path exists to prevent.
 */
const EXPECT_TTL_MS = 15 * 60 * 1000;
function auditTabs(tabs, { table, agents: registry } = {}) {
    const t = table || processTable();
    const rows = [];
    const byId = new Map();
    for (const tab of tabs || []) {
        if (!tab || tab.exited) continue;
        // A restore's expectation is judged by the audit scheduled for it and
        // then cleared; a stale one (that audit never ran) is not the reference.
        const fresh = tab.restoreExpect && !(tab.restoreExpect.at && Date.now() - tab.restoreExpect.at > EXPECT_TTL_MS);
        const exp = fresh ? tab.restoreExpect : { agent: tab.agent || null, sessionId: tab.sessionId || null };
        const expected = { agent: exp.agent || null, sessionId: exp.sessionId || null };
        const seen = t && tab.pty && tab.pty.pid ? observe(tab.pty.pid, t, registry) : null;
        const observed = seen ? { agent: seen.agent, sessionId: seen.sessionId || null } : null;
        let status;
        if (!observed) status = expected.sessionId ? 'missing' : 'shell';
        else if (expected.agent && observed.agent !== expected.agent) status = 'wrong-agent';
        else if (expected.sessionId && observed.sessionId && observed.sessionId !== expected.sessionId) status = 'wrong-session';
        else if (expected.sessionId && !observed.sessionId) status = 'unverified';
        else status = 'ok';
        rows.push({ id: tab.id, title: tab.title, cwd: tab.cwd, expected, observed, status });
        if (observed && observed.sessionId) {
            if (!byId.has(observed.sessionId)) byId.set(observed.sessionId, []);
            byId.get(observed.sessionId).push(tab.id);
        }
    }
    const duplicates = [...byId].filter(([, ids]) => ids.length > 1).map(([sessionId, ids]) => ({ sessionId, tabs: ids }));
    const counts = {};
    for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
    return { at: new Date().toISOString(), tabs: rows, duplicates, counts, psOk: !!t };
}

/** One line for the daemon log: "14 tab(s) · 12 ok · 1 missing · 0 duplicate id(s)". */
function auditSummary(a) {
    const parts = Object.entries(a.counts || {}).sort().map(([k, n]) => `${n} ${k}`);
    return `${(a.tabs || []).length} tab(s)${parts.length ? ' · ' + parts.join(' · ') : ''} · ${(a.duplicates || []).length} duplicate id(s)`
        + (a.psOk === false ? ' · ps unavailable' : '')
        + (a.registry === false ? ' · claude registry unavailable (claude threads unverified)' : '');
}

/**
 * One-shot hints for the restart itself. A daemon running code older than the
 * identity sweep flushes a tabs.json with no ids, so the restart that installs
 * this fix would still guess. A `session-hints.json` written just before that
 * restart ({savedAt, tabs:[{cwd, agent?, sessionId}]} in tabs.json order — see
 * docs/fleet-recovery.md) is applied here at boot, then retired so it can
 * never override a later run. `agent` defaults to claude (registry ids).
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
    const set = (entry, h) => {
        const kind = h.agent === 'codex' ? 'codex' : 'claude';
        // A hint never changes a tab's KNOWN agent: that would type one
        // agent's id into the other.
        if (entry.agent && entry.agent !== kind) return;
        // An unset agent would let auto-resume guess the kind from mtimes.
        if (!entry.agent) entry.agent = kind;
        if (entry.sessionId !== h.sessionId) { entry.sessionId = h.sessionId; entry.sessionCwd = null; applied++; }
    };
    entries.forEach((entry, i) => {
        const h = hints.tabs[i];
        if (entry && valid(h) && h.cwd === entry.cwd) { set(entry, h); used.add(i); }
    });
    entries.forEach((entry, i) => {
        if (!entry || (valid(hints.tabs[i]) && hints.tabs[i].cwd === entry.cwd)) return;
        const live = entries.filter(e => e && e.cwd === entry.cwd);
        const cand = hints.tabs.map((h, j) => [h, j]).filter(([h, j]) => valid(h) && h.cwd === entry.cwd && !used.has(j));
        if (live.length === 1 && cand.length === 1) { set(entry, cand[0][0]); used.add(cand[0][1]); }
    });
    return { applied, reason: 'ok' };
}

module.exports = {
    processTable, processTableAsync, parseTable, descendants, idFromCommand, observe, stampTabs, auditTabs, auditSummary,
    parseAgents, claudeAgents, claudeAgentsSync, cachedAgents, applyHints, hintsPath,
    _setCachedAgentsForTest: (map, at = Date.now()) => { _lastAgents = map; _lastAgentsAt = at; },
};
