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
        tab.restoreExpect = { agent: entry.agent, sessionId: entry.sessionId, at: Date.now() };
        const wait = n++ * staggerMs;
        const t = setTimeout(() => {
            if (tab.exited) return;   // closed while we waited — nothing to launch into
            if (announce) { try { announce(tab); } catch (_) {} }
            try {
                sessionManager.launchClaude(tab, tab.cwd, {
                    resume: true, agent: entry.agent, sessionId: entry.sessionId,
                    sessionCwd: entry.sessionCwd, coldFallback: false, guess: false,
                    exact: !!entry.exact,
                });
            } catch (_) { /* a failed launch leaves a usable shell — never fatal */ }
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
let _lastAudit = null;

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
    const reg = agents || sessionIdentity.cachedAgents();
    const report = sessionIdentity.auditTabs(tabs, { table: t, agents: reg });
    report.registry = !!reg;
    // The audit IS a sweep: what it saw becomes the tabs' identity. A thread's
    // home directory is looked up lazily, at the next launch.
    if (t) {
        const r = sessionIdentity.stampTabs(tabs, { table: t, agents: reg });
        if (persist && (r.stamped || r.agents)) {
            const best = list.reduce((a, s) => (!a || s.tabMgr.order.length > a.tabMgr.order.length ? s : a), null);
            if (best) { try { tabPersist.save(best.tabMgr); } catch (_) {} }
        }
    }
    _lastAudit = report;
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
            if (!agents) a.registry = false;
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
// restore that started meanwhile has its own audit coming.
function clearExpectations(tabs, armedBefore) {
    for (const t of tabs) {
        if (t && t.restoreExpect && !(t.restoreExpect.at > armedBefore)) delete t.restoreExpect;
    }
}

function scheduleAudit(sessionsIterableFn, delayMs = AUDIT_SETTLE_MS) {
    const armedBefore = Date.now();
    const t = setTimeout(() => {
        auditFleetAsync(sessionsIterableFn, (a) => {
            try {
                logAudit(a);
                clearExpectations(_tabsOf([...(sessionsIterableFn() || [])].filter(s => s && s.tabMgr)), armedBefore);
            } catch (e) { console.log('fleet-audit failed:', (e && e.message) || e); }
        });
    }, delayMs);
    if (t.unref) t.unref();
    return t;
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
        if (req.query && req.query.last && _lastAudit) return res.json({ ok: true, ..._lastAudit, cached: true });
        auditFleetAsync(() => sessions.sessions.values(), (a) => {
            res.json({ ok: true, ...a, summary: sessionIdentity.auditSummary(a) });
        });
    });
}

module.exports = {
    mount, restoreFleet, pickSource, recentSessionsByCwd,
    allocate, claimedIds, recentMaps, launchAll, auditFleet, auditFleetAsync, scheduleAudit,
    fillIdentity, clearExpectations,
};
