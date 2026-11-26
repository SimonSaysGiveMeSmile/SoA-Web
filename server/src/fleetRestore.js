/**
 * fleetRestore — ONE implementation of "bring the terminals back".
 *
 * The fleet has been rebuilt by hand three times now (2026-06-29, 2026-07-08,
 * 2026-08-31), and each time the same five steps ran in the same order:
 *
 *   1. pick the richest surviving list of tabs — tabs.json, else the protected
 *      tabs.json.lastgood, else a rotated tabs.json.bak-*, else the per-tab cwds
 *      that scrollback.json still carries;
 *   2. drop entries whose cwd no longer exists on disk;
 *   3. skip cwds that are ALREADY open, counting duplicates as a multiset — three
 *      blueprint tabs on one cwd must restore three tabs, not one;
 *   4. open the rest as real tabs on the live session;
 *   5. relaunch each one's agent. A tab that remembers its identity (agent +
 *      sessionId, persisted by tabPersist) gets EXACTLY that agent on EXACTLY
 *      that thread, from the thread's own directory, and nothing else on
 *      failure. Only a tab with no saved id is handed a recent thread for its
 *      cwd, distinct per tab and never one another tab (saved or live) owns —
 *      so two agents never attach to the same transcript. After the launches
 *      settle, an audit compares what was meant with what is running.
 *
 * That workflow lives here so every caller runs the same code: the Time Machine's
 * Restore button, the `soa-restore-fleet` CLI, and anything else that needs the
 * fleet back. It deliberately does NOT need the manager entitlement — recovering
 * your own terminals is not a premium fleet-control action, and the 2026-08-31
 * loss was made worse by the recovery CLI failing on an unlicensed install.
 *
 * Non-destructive by construction: it only ever OPENS tabs. Nothing here closes,
 * stops, or rewrites a live tab, so running it twice is a no-op the second time.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const tabPersist = require('./tabPersist');
const claudeSessions = require('./claudeSessions');
const codexSessions = require('./codexSessions');
const sessionIdentity = require('./sessionIdentity');
const sessionManager = require('./sessionManager');
const envStore = require('./envStore');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
// Stagger cold-starts: a dozen `claude --resume` processes launched in the same
// tick fight over CPU and the machine stalls for a minute.
const LAUNCH_STAGGER_MS = parseInt(process.env.SOA_WEB_RESTORE_STAGGER_MS || '1500', 10);
const MAX_TABS = 40;

function _norm(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const t of list) {
        if (!t || typeof t.cwd !== 'string' || !t.cwd) continue;
        // Only a name the user chose is carried; an auto/dedupe title
        // (Side-Proj-1) or the basename is re-derived by the tab manager, never
        // frozen — even when an older writer flagged it as a rename.
        const renamed = tabPersist.userNamed({ ...t, userRenamed: t.userRenamed || t.renamed });
        out.push({
            cwd: t.cwd,
            title: renamed ? String(t.title).slice(0, 64) : null,
            userRenamed: renamed,
            ...tabPersist.identityOf(t),
        });
        if (out.length >= MAX_TABS) break;
    }
    return out;
}

/**
 * The richest surviving tab list, and where it came from. Order matters: a live
 * tabs.json is the truth when it still holds a fleet, but a COLLAPSED one (0-1
 * tabs, the loss signature) must not shadow the protected snapshot behind it.
 */
function pickSource(explicit) {
    const explicitTabs = _norm(explicit);
    if (explicitTabs.length) return { from: 'request', tabs: explicitTabs };

    const meta = _norm((tabPersist.load() || {}).tabs);
    if (meta.length >= 2) return { from: 'tabs.json', tabs: meta };

    const lastgood = _norm((tabPersist.loadLastGood() || {}).tabs);
    if (lastgood.length >= 2) return { from: 'lastgood', tabs: lastgood };

    let baks = [];
    try {
        const dir = path.dirname(tabPersist.STATE_FILE);
        baks = fs.readdirSync(dir).filter(f => /^tabs\.json\.bak-/.test(f)).sort().reverse()
            .map(f => path.join(dir, f));
    } catch (_) { /* no backups — fall through to scrollback */ }
    for (const b of baks) {
        try {
            const t = _norm(JSON.parse(fs.readFileSync(b, 'utf8')).tabs);
            if (t.length >= 2) return { from: path.basename(b), tabs: t };
        } catch (_) { /* skip a corrupt backup, try the next */ }
    }

    // scrollback.json carries the live title; whether the user chose it comes
    // from its own userRenamed (older files: tabPersist's legacy heuristic).
    const sb = (tabPersist.loadScrollback() || {}).tabs;
    const fromSb = _norm((Array.isArray(sb) ? sb : []).map(t => t && ({
        ...t, userRenamed: tabPersist.renamedFromScrollback(t),
    })));
    if (fromSb.length >= 2) return { from: 'scrollback', tabs: fromSb };

    return { from: 'none', tabs: [] };
}

/**
 * An explicit list (the Time Machine's snapshot) knows each tab's cwd and title
 * but not which agent or thread it ran. Without this every such tab went to
 * the cwd guess, and Codex tabs came back as Claude. Fill identity from the
 * on-disk record — tabs.json, then lastgood — matching by cwd as a multiset in
 * order, and never with a thread in `skip` (live in some tab already: that tab
 * is the one the snapshot saw, not the one being rebuilt). Mutates `tabs`.
 */
function fillIdentity(tabs, { skip = new Set(), sources = null } = {}) {
    const lists = sources || [(tabPersist.load() || {}).tabs, (tabPersist.loadLastGood() || {}).tabs];
    const used = new Set(skip);
    for (const t of tabs) if (t.sessionId) used.add(t.sessionId);
    const pool = new Map();   // cwd -> [identity…] in saved order, both sources
    for (const list of lists) {
        for (const e of Array.isArray(list) ? list : []) {
            const id = e && tabPersist.identityOf(e);
            if (!id || !id.sessionId || typeof e.cwd !== 'string') continue;
            if (!pool.has(e.cwd)) pool.set(e.cwd, []);
            pool.get(e.cwd).push(id);
        }
    }
    let filled = 0;
    for (const t of tabs) {
        if (t.sessionId) continue;
        const hit = (pool.get(t.cwd) || []).find(id => !used.has(id.sessionId)
            && (!t.agent || t.agent === id.agent));
        if (!hit) continue;
        used.add(hit.sessionId);
        Object.assign(t, hit);
        filled++;
    }
    return filled;
}

/**
 * cwd -> [sessionId…] newest first. Unlike claudeSessions.latestSessionByCwd
 * (one id per cwd, which is all boot-restore needs) this keeps the whole list,
 * because tabs that SHARE a cwd each need their own conversation.
 */
function recentSessionsByCwd(wanted, hours = 168) {
    const cutoff = Date.now() - hours * 3600 * 1000;
    const want = new Set(wanted);
    const byCwd = new Map();
    let entries;
    try { entries = fs.readdirSync(PROJECTS_DIR); } catch (_) { return byCwd; }
    for (const entry of entries) {
        if (entry.startsWith('wf_') || entry === 'subagents') continue;
        if (entry.startsWith('-private-tmp') || entry.startsWith('-tmp')) continue;
        const dir = path.join(PROJECTS_DIR, entry);
        let files;
        try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch (_) { continue; }
        for (const f of files) {
            const sessionId = path.basename(f, '.jsonl');
            if (!SAFE_ID.test(sessionId)) continue;
            let mtime = 0;
            try { mtime = fs.statSync(path.join(dir, f)).mtimeMs; } catch (_) { continue; }
            if (mtime < cutoff) continue;
            const cwd = claudeSessions.resolveCwd(path.join(dir, f));
            if (!cwd || !want.has(cwd)) continue;
            if (!byCwd.has(cwd)) byCwd.set(cwd, []);
            byCwd.get(cwd).push({ sessionId, mtime });
        }
    }
    for (const list of byCwd.values()) list.sort((a, b) => b.mtime - a.mtime);
    return byCwd;
}

/**
 * Every thread a live tab already owns, across all sessions. A restore must
 * never hand one of these to another tab. `except` holds tabs being restored
 * right now, whose seeded ids are theirs to keep, not someone else's claim.
 */
function claimedIds(sessionsIterable, except = null) {
    const ids = new Set();
    for (const s of sessionsIterable || []) {
        if (!s || !s.tabMgr) continue;
        for (const id of s.tabMgr.order) {
            const t = s.tabMgr.tabs.get(id);
            if (!t || t.exited || (except && except.has(t))) continue;
            if (t.sessionId) ids.add(t.sessionId);
        }
    }
    return ids;
}

/**
 * Decide which thread each entry resumes. Mutates and returns `entries`:
 * each gets {agent, sessionId, sessionCwd, exact}.
 *
 *   pass 1 — identity. An entry with agent + sessionId keeps it (exact) unless
 *            that id is already claimed — by a live tab, or by an EARLIER
 *            entry (a tabs.json written by a bad restore can hold one id
 *            twice). A loser keeps its agent and loses only the id.
 *   pass 2 — allocation, for entries with no id: the newest recent thread of
 *            the entry's agent (unknown agent → whichever agent's thread for
 *            the cwd is newer) that nobody has claimed. Nothing left → no id,
 *            and the caller leaves that tab at its shell.
 *
 * `maps` = { claude: Map<cwd,[{sessionId,mtime}]>, codex: same } newest first;
 * omit it to run pass 1 alone (a cheap dedupe at open time).
 */
function allocate(entries, { maps = null, claimed = new Set() } = {}) {
    const taken = new Set(claimed);
    for (const e of entries) {
        Object.assign(e, tabPersist.identityOf(e), { exact: false });
        if (!e.sessionId) continue;
        if (taken.has(e.sessionId)) {
            console.log(`fleet-restore: ${e.cwd} shares ${e.sessionId.slice(0, 8)} with another tab — not resuming it twice`);
            // Its thread is someone else's now. It stays at its shell — handing
            // it a DIFFERENT recent thread in pass 2 would resume a
            // conversation nobody asked for.
            e.sessionId = null; e.sessionCwd = null; e.lostId = true;
            continue;
        }
        taken.add(e.sessionId);
        e.exact = true;
    }
    if (!maps) return entries;
    for (const e of entries) {
        if (e.sessionId || e.lostId) continue;
        const ch = (maps.claude && maps.claude.get(e.cwd)) || [];
        const cx = (maps.codex && maps.codex.get(e.cwd)) || [];
        const kind = e.agent || (cx[0] && (!ch[0] || cx[0].mtime > ch[0].mtime) ? 'codex' : ch[0] ? 'claude' : null);
        if (!kind) continue;
        const pick = (kind === 'codex' ? cx : ch).find(x => !taken.has(x.sessionId));
        e.agent = kind;
        if (!pick) continue;
        taken.add(pick.sessionId);
        e.sessionId = pick.sessionId;
        e.sessionCwd = e.cwd;   // the lists are keyed by each thread's own cwd
    }
    return entries;
}

/** Both agents' recent threads per cwd, for allocate(). */
function recentMaps(cwds, hours = 72) {
    let claude = new Map(), codex = new Map();
    try { claude = recentSessionsByCwd(cwds, hours); } catch (_) {}
    try { codex = codexSessions.recentSessionsByCwd(hours); } catch (_) {}
    return { claude, codex };
}

/**
 * Launch each tab's allocated agent, staggered. Exact ids only (guess:false),
 * no cold fallback: a resume that fails leaves the shell, never a fresh or a
 * borrowed conversation. Records what was meant on `tab.restoreExpect` for the
 * audit. Only an EXACT id is stamped on the tab as identity: an allocated one
 * is a guess, and a guess persisted as identity would be resumed exactly on
 * every later restart. The sweep stamps it once the process is seen on it.
 * Returns how many were armed.
 */
function launchAll(pairs, { announce = null, staggerMs = LAUNCH_STAGGER_MS } = {}) {
    let n = 0;
    for (const { tab, entry } of pairs) {
        if (!entry.agent || !entry.sessionId) continue;
        // `exact` + `sessionCwd`: a repair (repairFleet) acts only on what was
        // identity, never on an allocated guess, and relaunches from its home.
        tab.restoreExpect = { agent: entry.agent, sessionId: entry.sessionId, sessionCwd: entry.sessionCwd || null,
            exact: !!entry.exact, at: Date.now() };
        const wait = n++ * staggerMs;
        // When this launch is due: a repair leaves the tab alone until it has
        // had time to show up (launchInFlight), instead of typing a second line.
        tab.restoreLaunchAt = Date.now() + wait;
        const t = setTimeout(() => {
            if (tab.exited) return;   // closed while we waited — nothing to launch into
            // An agent already in front (a repair, or the user, got there
            // first): our line would land in it as a prompt.
            sessionIdentity.processTableAsync((table) => {
                if (tab.exited) return;
                if (table && tab.pty && tab.pty.pid && sessionIdentity.observe(tab.pty.pid, table, null)) return;
                if (announce) { try { announce(tab); } catch (_) {} }
                try {
                    sessionManager.launchClaude(tab, tab.cwd, {
                        resume: true, agent: entry.agent, sessionId: entry.sessionId,
                        sessionCwd: entry.sessionCwd, coldFallback: false, guess: false,
                        exact: !!entry.exact,
                    });
                } catch (_) { /* a failed launch leaves a usable shell — never fatal */ }
            });
        }, wait);
        if (t.unref) t.unref();
    }
    return n;
}

// ── Post-restore audit ────────────────────────────────────────────────────────
// A restore is only as good as what is running afterwards. Once the launches
// have settled, one identity sweep compares each tab's expected {agent,
// sessionId} with the foreground process, and flags any thread live in two
// tabs. The result is logged in one line and kept for GET /api/fleet/audit.
const AUDIT_SETTLE_MS = parseInt(process.env.SOA_WEB_RESTORE_AUDIT_MS || '25000', 10);
let _lastScheduled = null;   // the last audit a restore scheduled (GET ?last=1)

function _tabsOf(list) {
    const tabs = [];
    for (const s of list) for (const id of s.tabMgr.order) { const t = s.tabMgr.tabs.get(id); if (t) tabs.push(t); }
    return tabs;
}

// Judges a given process table (and registry) when passed one. Without a
// table it reads one synchronously — tests and the sync paths only; the
// daemon goes through auditFleetAsync.
function auditFleet(sessionsIterable, { table = null, agents = null, persist = true } = {}) {
    const list = [...(sessionsIterable || [])].filter(s => s && s.tabMgr);
    const tabs = _tabsOf(list);
    const t = table || sessionIdentity.processTable();
    const reg = agents || sessionIdentity.withCodex(sessionIdentity.cachedAgents(), sessionIdentity.cachedCodex());
    const report = sessionIdentity.auditTabs(tabs, { table: t, agents: reg });
    report.registry = sessionIdentity.hasClaudeRegistry(reg);
    // The audit IS a sweep: what it saw becomes the tabs' identity. A thread's
    // home directory is looked up lazily, at the next launch.
    if (t) {
        const r = sessionIdentity.stampTabs(tabs, { table: t, agents: reg });
        if (persist && (r.stamped || r.agents)) {
            const best = list.reduce((a, s) => (!a || s.tabMgr.order.length > a.tabMgr.order.length ? s : a), null);
            if (best) { try { tabPersist.save(best.tabMgr); } catch (_) {} }
        }
    }
    return report;
}

// The daemon's audit: a FRESH registry answer (the only source of a Claude
// thread id — a cached one has never seen the pids a restore just launched, so
// they would read as unverified and a doubled thread would go unreported) and
// an async `ps`, so nothing blocks the event loop.
function auditFleetAsync(sessionsIterableFn, cb) {
    sessionIdentity.claudeAgents((agents) => {
        sessionIdentity.processTableAsync((table) => {
            let a;
            try { a = auditFleet(sessionsIterableFn(), { table, agents: agents || null }); }
            catch (e) { a = { at: new Date().toISOString(), tabs: [], duplicates: [], counts: {}, psOk: false, error: String((e && e.message) || e) }; }
            // Without the registry no Claude tab's thread can be checked.
            if (!sessionIdentity.hasClaudeRegistry(agents)) a.registry = false;
            cb(a);
        });
    });
}

function logAudit(a) {
    console.log(`fleet-audit: ${sessionIdentity.auditSummary(a)}`);
    for (const r of a.tabs) {
        if (r.status === 'ok' || r.status === 'shell') continue;
        console.log(`fleet-audit:   #${r.id} ${r.status} expected ${r.expected.agent || '-'}:${(r.expected.sessionId || '-').slice(0, 8)}`
            + ` observed ${r.observed ? `${r.observed.agent}:${(r.observed.sessionId || '-').slice(0, 8)}` : 'shell'}`);
    }
    for (const d of a.duplicates) console.log(`fleet-audit:   DUPLICATE ${d.sessionId.slice(0, 8)} live in tabs ${d.tabs.join(', ')}`);
}

// What a restore meant is judged ONCE, by the audit scheduled for it. After
// that the tab's own identity is the reference, so a later live audit does not
// keep calling a tab wrong for a thread the user has since moved on from.
// Only expectations armed before this audit was scheduled are cleared — a
// restore that started meanwhile has its own audit coming. An EXACT
// expectation the audit found broken is kept (it expires with EXPECT_TTL_MS):
// the sweep has already stamped the wrong observed thread on the tab, so it is
// the only record of what POST /api/fleet/repair should put back.
function clearExpectations(tabs, armedBefore, report = null) {
    const bad = new Set(((report && report.tabs) || []).filter(r => REPAIRABLE.has(r.status)).map(r => r.id));
    for (const t of tabs) {
        if (!t || !t.restoreExpect || t.restoreExpect.at > armedBefore) continue;
        if (t.restoreExpect.exact && bad.has(t.id)) continue;
        delete t.restoreExpect;
    }
}

function scheduleAudit(sessionsIterableFn, delayMs = AUDIT_SETTLE_MS) {
    const armedBefore = Date.now();
    const t = setTimeout(() => {
        auditFleetAsync(sessionsIterableFn, (a) => {
            _lastScheduled = { ...a, scheduled: true };
            try {
                logAudit(a);
                clearExpectations(_tabsOf([...(sessionsIterableFn() || [])].filter(s => s && s.tabMgr)), armedBefore, a);
            } catch (e) { console.log('fleet-audit failed:', (e && e.message) || e); }
            // Opt-in: put a wrong agent / wrong thread back without waiting for
            // a person. Off by default — it kills processes in live tabs.
            if (process.env.SOA_WEB_RESTORE_AUTOREPAIR === '1'
                && a.tabs.some(r => r.status === 'wrong-agent' || r.status === 'wrong-session')) {
                repairFleet(sessionsIterableFn, { statuses: new Set(['wrong-agent', 'wrong-session']) })
                    .catch(e => console.log('fleet-repair failed:', (e && e.message) || e));
            }
        });
    }, delayMs);
    if (t.unref) t.unref();
    return t;
}

// ── Exact repair ──────────────────────────────────────────────────────────────
// The manual repair in docs/fleet-recovery.md, as one call: for each tab the
// audit flags, stop the foreground agent until only the shell is left, clear
// the prompt line, and type the exact launch line for the thread the tab is
// meant to be on. Only an EXACT expectation is acted on — a restore's exact id
// (restoreExpect.exact) or the tab's own recorded identity — never a guess, and
// never the manager's tab or the caller's own.
const REPAIRABLE = new Set(['wrong-agent', 'wrong-session', 'missing']);
const REPAIR_POLL_MS = parseInt(process.env.SOA_WEB_REPAIR_POLL_MS || '2000', 10);
const REPAIR_VERIFY_MS = parseInt(process.env.SOA_WEB_REPAIR_VERIFY_MS || '10000', 10);
// A launch due less than this long ago may not have a process yet: `missing`
// then means "still starting", and a second line would land in the agent.
const LAUNCH_GRACE_MS = parseInt(process.env.SOA_WEB_REPAIR_GRACE_MS || '20000', 10);
function launchInFlight(tab, now = Date.now()) {
    return !!tab && Number.isFinite(tab.restoreLaunchAt) && now < tab.restoreLaunchAt + LAUNCH_GRACE_MS;
}
const _sleep = ms => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
let _repairBusy = false;

function _isManagerTab(tab) {
    return !!tab && typeof tab.title === 'string' && tab.title.trim().toLowerCase() === 'manager';
}

// What the tab must be on, when that is known exactly; null otherwise. A
// restore's expectation counts only when it was exact (never an allocated
// guess). Without one, the reference is the tab's own identity as the audit
// judged it (`row.expected`: the sweep that ran with the audit has since
// stamped the observed thread on the tab) — and only for `missing`: a live
// agent that differs from the tab's remembered id is the user's own switch,
// which the sweep adopts, not damage to undo.
function exactExpectation(tab, row, now = Date.now()) {
    const re = tab && tab.restoreExpect;
    if (re && !(re.at && now - re.at > sessionIdentity.EXPECT_TTL_MS)) {
        return re.exact && re.agent && re.sessionId
            ? { agent: re.agent, sessionId: re.sessionId, sessionCwd: re.sessionCwd || null } : null;
    }
    const e = row && row.expected;
    if (!e || !e.agent || !e.sessionId || row.status !== 'missing') return null;
    return { agent: e.agent, sessionId: e.sessionId, sessionCwd: tab.sessionId === e.sessionId ? tab.sessionCwd || null : null };
}

/**
 * Pure: which tabs to repair, and with which line. `pairs` = [{tab, row}] (an
 * audit row next to its tab). A thread that stays live in a tab nobody is
 * repairing is never resumed a second time; neither is one two tabs expect.
 * Returns {plan:[{id, tab, before, agent, sessionId, sessionCwd, line}], left:[{id, before, action, why}]}.
 */
function planRepair(pairs, { duplicates = [], ids = null, selfId = null, statuses = REPAIRABLE, registry = true,
    resolveCwd = sessionManager.sessionCwdFor, exists = fs.existsSync, now = Date.now() } = {}) {
    const want = Array.isArray(ids) && ids.length ? new Set(ids.map(Number)) : null;
    const liveOn = new Map();   // observed thread -> tab ids
    for (const { row } of pairs) {
        const sid = row.observed && row.observed.sessionId;
        if (sid) liveOn.set(sid, [...(liveOn.get(sid) || []), row.id]);
    }
    const left = [];
    const skip = (row, why) => left.push({ id: row.id, before: row.status, action: 'skipped', why });
    const cands = [];
    for (const { tab, row } of pairs) {
        if (want && !want.has(row.id)) continue;
        if (!statuses.has(row.status)) continue;   // ok / unverified / shell: nothing to put back
        if (_isManagerTab(tab)) { skip(row, 'manager tab'); continue; }
        if (selfId != null && row.id === selfId) { skip(row, 'caller tab'); continue; }
        if (launchInFlight(tab, now)) { skip(row, 'a launch is still in flight'); continue; }
        // Without the registry a Claude thread is read off argv only: not
        // enough to call a running agent wrong.
        if (registry === false && row.status === 'wrong-session' && row.observed && row.observed.agent === 'claude') {
            skip(row, 'claude registry unavailable'); continue;
        }
        const exp = exactExpectation(tab, row, now);
        if (!exp) { skip(row, 'no exact expected identity'); continue; }
        cands.push({ tab, row, exp });
    }
    const moving = new Set(cands.map(c => c.row.id));
    const taken = new Set();
    const plan = [];
    for (const { tab, row, exp } of cands) {
        const others = (liveOn.get(exp.sessionId) || []).filter(id => id !== row.id);
        const keeper = others.find(id => !moving.has(id));
        if (keeper != null) { skip(row, `${exp.sessionId.slice(0, 8)} is live in tab #${keeper}`); continue; }
        if (taken.has(exp.sessionId)) { skip(row, `${exp.sessionId.slice(0, 8)} is expected by another tab too`); continue; }
        taken.add(exp.sessionId);
        let home = exp.sessionCwd;
        if (!home) { try { home = resolveCwd(exp.agent, exp.sessionId) || null; } catch (_) { home = null; } }
        if (home && !exists(home)) home = null;
        const line = sessionManager.agentLaunchLine(exp.agent, { sessionId: exp.sessionId, sessionCwd: home, cwd: tab.cwd });
        // `holders`: tabs being repaired that still run this thread — each must
        // be stopped before it is launched here (a swap). `pid`: the process
        // the audit judged (null for `missing`), the only one stopAgent may stop.
        plan.push({ id: row.id, tab, before: row.status, agent: exp.agent, sessionId: exp.sessionId,
            sessionCwd: home, line, holders: others, pid: row.pid != null ? row.pid : null });
    }
    // A thread on two tabs: the tab whose own identity it is keeps it; one
    // with an exact id of its own is in the plan; the rest are reported.
    const planned = new Set(plan.map(p => p.id));
    const reported = new Set(left.map(l => l.id));
    for (const d of duplicates || []) {
        for (const { row } of pairs) {
            if (!d.tabs.includes(row.id) || planned.has(row.id) || reported.has(row.id)) continue;
            if (row.expected && row.expected.sessionId === d.sessionId) continue;   // its own thread
            left.push({ id: row.id, before: 'duplicate', action: 'left',
                why: `shares ${d.sessionId.slice(0, 8)} with tab(s) ${d.tabs.filter(x => x !== row.id).join(', ')}; no exact id of its own` });
            reported.add(row.id);
        }
    }
    return { plan, left };
}

/**
 * Stop whatever agent runs in front of this PTY's shell, re-checking until only
 * the shell is left: SIGTERM, then SIGKILL from the `killAfter`th try on. Each
 * check reads the table afresh, so a `|| fallback` agent the old chain starts
 * is caught too. Never signals the shell itself.
 *
 * `planned` (when given) is the agent pid the audit judged, or null for "no
 * agent": if the first look disagrees, the tab changed since the audit (the
 * user started the right agent, a late restore launch landed) and nothing is
 * signalled. Done only when the shell has NO child left — a vim, a REPL or an
 * ssh in front is not an idle prompt, and is never typed into.
 * Resolves {ok, signalled, changed?, why?}.
 */
async function stopAgent(ptyPid, { table = () => new Promise(r => sessionIdentity.processTableAsync(r)),
    kill = (pid, sig) => process.kill(pid, sig), sleep = _sleep, intervalMs = REPAIR_POLL_MS,
    tries = 10, killAfter = 6, busyChecks = 2, planned } = {}) {
    const signalled = [];
    let busy = 0;
    for (let i = 0; ; i++) {
        const t = await table();
        if (!t) return { ok: false, signalled, why: 'ps unavailable' };
        const seen = sessionIdentity.observe(ptyPid, t, null);
        if (i === 0 && planned !== undefined && (planned == null ? !!seen : (!seen || seen.pid !== planned))) {
            return { ok: false, changed: true, signalled, why: 'changed since audit' };
        }
        if (!seen) {
            const kids = sessionIdentity.descendants(ptyPid, t.kids);
            if (!kids.length) return { ok: true, signalled };
            // A subshell of the old chain may still be on its way out.
            if (busy++ >= busyChecks) {
                return { ok: false, signalled, why: `shell is busy: ${((t.procs.get(kids[0]) || {}).cmd || kids[0]).toString().slice(0, 60)}` };
            }
            await sleep(intervalMs);
            continue;
        }
        if (signalled.length >= tries) return { ok: false, signalled, why: `agent pid ${seen.pid} still running` };
        const sig = signalled.length >= killAfter ? 'SIGKILL' : 'SIGTERM';
        try { kill(seen.pid, sig); } catch (_) { /* already gone */ }
        signalled.push({ pid: seen.pid, sig });
        await sleep(intervalMs);
    }
}

// A fresh audit, each row next to its tab (auditTabs skips exited tabs, in order).
function _auditPairs(sessionsIterableFn) {
    return new Promise((resolve) => auditFleetAsync(sessionsIterableFn, (report) => {
        const list = [...(sessionsIterableFn() || [])].filter(s => s && s.tabMgr);
        const tabs = _tabsOf(list).filter(t => t && !t.exited);
        resolve({ report, pairs: report.tabs.map((row, i) => ({ row, tab: tabs[i] })).filter(p => p.tab && p.tab.id === p.row.id) });
    }));
}

/**
 * Audit, repair each flagged tab one at a time, re-audit. opts: ids, dryRun,
 * selfId, statuses, staggerMs, verifyMs; for tests, stop (a stopAgent
 * stand-in) and audit (an _auditPairs stand-in).
 * Resolves {ok, dryRun?, results:[{id, before, action, after, line?, why?}], summary}.
 */
async function repairFleet(sessionsIterableFn, opts = {}) {
    if (_repairBusy) return { ok: false, error: 'a repair is already running', results: [] };
    _repairBusy = true;
    try {
        const audit = opts.audit || _auditPairs;   // tests inject a report
        const { report, pairs } = await audit(sessionsIterableFn);
        // No process table: every tab with an id reads `missing`, healthy or
        // not. Acting on that would kill the whole fleet's live agents.
        if (report.psOk === false) {
            return { ok: false, error: 'ps unavailable — nothing repaired', results: [], summary: sessionIdentity.auditSummary(report) };
        }
        const { plan, left } = planRepair(pairs, { duplicates: report.duplicates, ids: opts.ids,
            selfId: opts.selfId, statuses: opts.statuses || REPAIRABLE, registry: report.registry !== false });
        const results = left.map(l => ({ ...l, after: l.before }));
        if (opts.dryRun) {
            return { ok: true, dryRun: true, summary: sessionIdentity.auditSummary(report),
                results: plan.map(p => ({ id: p.id, before: p.before, action: 'would-relaunch', after: null, line: p.line })).concat(results) };
        }
        const stop = opts.stop || stopAgent;
        const stagger = opts.staggerMs != null ? opts.staggerMs : LAUNCH_STAGGER_MS;
        const done = [];
        const skipTab = (r, p, why) => { r.action = 'skipped'; r.after = p.before; r.why = why; results.push(r); };
        // Stop every planned tab first, THEN launch: in a swap (#1 runs #2's
        // thread and #2 runs #1's) a launch before the other tab is stopped
        // would put two processes on one transcript.
        const stopped = [];
        for (const p of plan) {
            const r = { id: p.id, before: p.before, action: null, after: null, line: p.line };
            const pid = p.tab.pty && p.tab.pty.pid;
            const s = p.tab.exited || !pid ? { ok: false, why: 'tab is gone' } : await stop(pid, { planned: p.pid });
            if (!s.ok || p.tab.exited) { skipTab(r, p, s.why || 'tab is gone'); continue; }
            stopped.push({ p, r, s });
            if (s.signalled && s.signalled.length) await _sleep(stagger);
        }
        const free = new Set(stopped.map(x => x.p.id));
        for (const { p, r, s } of stopped) {
            const holder = p.holders.find(id => !free.has(id));
            if (holder != null) { skipTab(r, p, `${p.sessionId.slice(0, 8)} is still live in tab #${holder}`); continue; }
            // Still an idle prompt? Something may have started since its stop.
            const idle = p.tab.exited ? { ok: false, why: 'tab is gone' } : await stop(p.tab.pty.pid, { planned: null });
            if (!idle.ok) { skipTab(r, p, idle.why || 'changed since stop'); continue; }
            try { p.tab.write('\x15'); } catch (_) {}   // Ctrl-U: an empty prompt line
            try {
                sessionManager.launchClaude(p.tab, p.tab.cwd, { resume: true, agent: p.agent, sessionId: p.sessionId,
                    sessionCwd: p.sessionCwd, coldFallback: false, guess: false, exact: true });
                p.tab.restoreLaunchAt = Date.now();   // a second repair leaves it to start
                r.action = s.signalled && s.signalled.length ? 'stopped+relaunched' : 'relaunched';
                done.push({ r, tab: p.tab });
            } catch (e) { r.action = 'failed'; r.why = String((e && e.message) || e); }
            results.push(r);
            await _sleep(stagger);
        }
        let summary = sessionIdentity.auditSummary(report);
        if (done.length) {
            await _sleep(opts.verifyMs != null ? opts.verifyMs : REPAIR_VERIFY_MS);
            const again = await audit(sessionsIterableFn);
            summary = sessionIdentity.auditSummary(again.report);
            for (const { r, tab } of done) {
                const hit = again.pairs.find(x => x.tab === tab);
                r.after = hit ? hit.row.status : 'gone';
                if (r.after === 'ok') delete tab.restoreExpect;   // judged: back on its thread
            }
        }
        const n = k => results.filter(r => r.action === k || (k === 'relaunched' && /relaunched$/.test(r.action || ''))).length;
        console.log(`fleet-repair: ${plan.length} planned · ${n('relaunched')} relaunched · ${n('skipped') + n('left')} left`
            + ` · ${done.filter(d => d.r.after === 'ok').length} ok after · now ${summary}`);
        return { ok: true, results, summary };
    } finally {
        _repairBusy = false;
    }
}

/**
 * Rebuild the fleet on `session`. Returns a report — never throws for a single
 * bad entry, because a restore that gives up halfway is worse than one that
 * reports what it could not do.
 *
 *   opts.tabs     explicit [{cwd,title,userRenamed,agent,sessionId,sessionCwd}]
 *                 (the Time Machine passes the snapshot's tabs); omitted → the
 *                 best on-disk source
 *   opts.resume   relaunch each opened tab's agent (default true)
 *   opts.dryRun   plan only
 *   opts.sessions every live session (for ids already claimed); default [session]
 */
function restoreFleet(session, opts = {}) {
    const resume = opts.resume !== false;
    const dryRun = !!opts.dryRun;
    if (!session || !session.tabMgr) return { ok: false, error: 'no active session', opened: [], skipped: [] };

    const src = pickSource(opts.tabs);
    if (!src.tabs.length) return { ok: false, error: 'no fleet source found', from: src.from, opened: [], skipped: [] };

    const allSessions = opts.sessions ? [...opts.sessions] : [session];
    const claimed = claimedIds(allSessions);
    // A snapshot's tabs carry no identity of their own: take it from disk.
    if (src.from === 'request') fillIdentity(src.tabs, { skip: claimed });

    // What is already open. A thread live in ANY session is open — re-opening
    // it here would only lose its id to the claim check and leave a duplicate
    // shell. Otherwise each live tab of THIS session consumes one id-less
    // entry on its cwd (a multiset: three tabs on one project restore three).
    const skipped = [];
    const present = [];
    for (const entry of src.tabs) {
        if (!fs.existsSync(entry.cwd)) { skipped.push({ ...entry, why: 'missing dir' }); continue; }
        present.push(entry);
    }
    const planned = tabPersist.planRestore(present, tabPersist.liveTabs([session]), { elsewhere: claimed });
    const opening = new Set(planned.open.map(o => o.index));
    present.forEach((entry, i) => { if (!opening.has(i)) skipped.push({ ...entry, why: 'already open' }); });
    const plan = planned.open.map(o => o.entry);

    // Saved identity first; distinct unclaimed recent threads only for the rest.
    allocate(plan, {
        maps: resume ? recentMaps(plan.map(t => t.cwd)) : null,
        claimed,
    });

    if (dryRun) return { ok: true, from: src.from, dryRun: true, opened: plan, skipped };

    const shellEnv = envStore.getEnvForShell();
    const opened = [];
    for (const entry of plan) {
        let tab;
        try {
            tab = session.tabMgr.open({
                title: entry.userRenamed && entry.title ? entry.title : undefined,
                userRenamed: !!entry.userRenamed,
                cwd: entry.cwd,
                env: shellEnv,
                silent: true,
                // Identity only when it is one: an allocated thread is a guess
                // (restoreExpect + the sweep record it once it is really running).
                agent: entry.agent,
                sessionId: entry.exact ? entry.sessionId : null,
                sessionCwd: entry.exact ? entry.sessionCwd : null,
            });
        } catch (e) {
            skipped.push({ ...entry, why: `open failed: ${(e && e.message) || e}` });
            continue;
        }
        if (!tab) { skipped.push({ ...entry, why: 'open returned nothing' }); continue; }
        opened.push({ id: tab.id, title: tab.title, cwd: entry.cwd, agent: entry.agent || null,
            sessionId: entry.sessionId || null, exact: !!entry.exact, tab, entry });
    }

    let armed = 0;
    if (resume) {
        armed = launchAll(opened);
        if (armed) scheduleAudit(() => allSessions, armed * LAUNCH_STAGGER_MS + AUDIT_SETTLE_MS);
    }
    for (const o of opened) { delete o.tab; delete o.entry; }

    try { tabPersist.saveImmediate(session.tabMgr); } catch (_) {}
    console.log(`fleet-restore: opened ${opened.length} tab(s) from ${src.from}`
        + (skipped.length ? ` (${skipped.length} skipped)` : '')
        + (resume ? ` · resuming ${armed} (${opened.filter(o => o.exact).length} exact)` : ''));

    return { ok: true, from: src.from, opened, skipped, resumed: resume };
}

function mount(app, requireAuthed, sessions) {
    // Restoring your own terminals is not a manager action: no entitlement gate,
    // same auth as /api/tabs. The 2026-08-31 recovery was blocked because the
    // only restore path went through the licensed fleet-control surface.
    app.post('/api/fleet/restore', requireAuthed, (req, res) => {
        const s = (req.session && req.session.tabMgr) ? req.session
            : [...sessions.sessions.values()].find(x => x.tabMgr) || null;
        if (!s) return res.status(503).json({ ok: false, error: 'no active session' });
        const body = req.body || {};
        const out = restoreFleet(s, {
            tabs: body.tabs, resume: body.resume !== false, dryRun: !!body.dryRun,
            sessions: sessions.sessions.values(),
        });
        res.status(out.ok ? 200 : 409).json(out);
    });

    // Is every tab on the agent and thread it should be? Runs a sweep now and
    // reports expected vs observed per tab, plus any thread live in two tabs.
    // Same gate as restore — checking your own fleet is not a premium action.
    // ?last=1 returns the last scheduled audit instead of sweeping again.
    // A loopback caller (the runbook's curl) is let through WITHOUT
    // requireAuthed: that would provision a throwaway session for a cookieless
    // request and overwrite session.json, so a read-only health check would
    // cost the real session its cookie and tokens on the next restart.
    const localOrAuthed = (req, res, next) => (sessionManager.isLocalRequest(req) ? next() : requireAuthed(req, res, next));
    app.get('/api/fleet/audit', localOrAuthed, (req, res) => {
        // ?last=1: the last audit a RESTORE scheduled (`scheduled: true`) — an
        // ad-hoc sweep is not the restore's verdict, and soa-restart waits on it.
        if (req.query && req.query.last && _lastScheduled) return res.json({ ok: true, ..._lastScheduled, cached: true });
        auditFleetAsync(() => sessions.sessions.values(), (a) => {
            res.json({ ok: true, ...a, summary: sessionIdentity.auditSummary(a) });
        });
    });

    // Put every flagged tab back on its exact agent and thread (repairFleet).
    // Same gate as the audit. `x-soa-tab` names the caller's own tab (never
    // touched). It can take a minute: one tab at a time, then a re-audit.
    app.post('/api/fleet/repair', localOrAuthed, (req, res) => {
        const body = req.body || {};
        const self = parseInt(req.headers['x-soa-tab'] || req.headers['soa-web-tab'] || '', 10);
        repairFleet(() => sessions.sessions.values(), {
            ids: Array.isArray(body.ids) ? body.ids.filter(Number.isInteger) : null,
            dryRun: !!body.dryRun,
            selfId: Number.isInteger(self) ? self : null,
        }).then(out => res.status(out.ok ? 200 : 409).json(out),
            e => res.status(500).json({ ok: false, error: String((e && e.message) || e), results: [] }));
    });
}

module.exports = {
    mount, restoreFleet, pickSource, recentSessionsByCwd,
    allocate, claimedIds, recentMaps, launchAll, auditFleet, auditFleetAsync, scheduleAudit,
    fillIdentity, clearExpectations, planRepair, stopAgent, repairFleet, exactExpectation, launchInFlight, REPAIRABLE,
};
