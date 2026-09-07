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
 *   5. resume each one's Claude conversation, giving tabs that share a cwd
 *      DISTINCT recent session ids (newest first) so two agents never attach to
 *      the same transcript.
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
        out.push({
            cwd: t.cwd,
            title: (t.userRenamed || t.renamed) && t.title ? String(t.title).slice(0, 64) : (t.title ? String(t.title).slice(0, 64) : null),
            userRenamed: !!(t.userRenamed || t.renamed),
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

    // scrollback.json carries the live title but not userRenamed; a title that
    // differs from the cwd basename is a rename worth keeping.
    const sb = (tabPersist.loadScrollback() || {}).tabs;
    const fromSb = _norm((Array.isArray(sb) ? sb : []).map(t => t && ({
        cwd: t.cwd, title: t.title,
        userRenamed: !!(t.title && t.cwd && t.title !== path.basename(t.cwd)),
    })));
    if (fromSb.length >= 2) return { from: 'scrollback', tabs: fromSb };

    return { from: 'none', tabs: [] };
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
 * Rebuild the fleet on `session`. Returns a report — never throws for a single
 * bad entry, because a restore that gives up halfway is worse than one that
 * reports what it could not do.
 *
 *   opts.tabs    explicit [{cwd,title,userRenamed}] (the Time Machine passes the
 *                snapshot's tabs); omitted → the best on-disk source
 *   opts.resume  launch `claude --resume <id>` in each opened tab (default true)
 *   opts.dryRun  plan only
 */
function restoreFleet(session, opts = {}) {
    const resume = opts.resume !== false;
    const dryRun = !!opts.dryRun;
    if (!session || !session.tabMgr) return { ok: false, error: 'no active session', opened: [], skipped: [] };

    const src = pickSource(opts.tabs);
    if (!src.tabs.length) return { ok: false, error: 'no fleet source found', from: src.from, opened: [], skipped: [] };

    // Multiset of live cwds: each live tab consumes one saved entry, so a project
    // with three tabs still restores the two that are missing.
    const live = new Map();
    for (const id of session.tabMgr.order) {
        const t = session.tabMgr.tabs.get(id);
        if (t && t.cwd) live.set(t.cwd, (live.get(t.cwd) || 0) + 1);
    }

    const plan = [];
    const skipped = [];
    for (const entry of src.tabs) {
        if (!fs.existsSync(entry.cwd)) { skipped.push({ ...entry, why: 'missing dir' }); continue; }
        const have = live.get(entry.cwd) || 0;
        if (have > 0) { live.set(entry.cwd, have - 1); skipped.push({ ...entry, why: 'already open' }); continue; }
        plan.push(entry);
    }

    // Hand out distinct transcripts to tabs sharing a cwd, newest first.
    const sessions = resume ? recentSessionsByCwd(plan.map(t => t.cwd)) : new Map();
    const taken = new Map();
    for (const entry of plan) {
        const list = sessions.get(entry.cwd) || [];
        const i = taken.get(entry.cwd) || 0;
        taken.set(entry.cwd, i + 1);
        entry.sessionId = list[i] ? list[i].sessionId : null;
    }

    if (dryRun) return { ok: true, from: src.from, dryRun: true, opened: plan, skipped };

    const shellEnv = envStore.getEnvForShell();
    const opened = [];
    for (const entry of plan) {
        let tab;
        try {
            tab = session.tabMgr.open({
                title: entry.userRenamed && entry.title ? entry.title : undefined,
                cwd: entry.cwd,
                env: shellEnv,
                silent: true,
            });
        } catch (e) {
            skipped.push({ ...entry, why: `open failed: ${(e && e.message) || e}` });
            continue;
        }
        if (!tab) { skipped.push({ ...entry, why: 'open returned nothing' }); continue; }
        opened.push({ id: tab.id, title: tab.title, cwd: entry.cwd, sessionId: entry.sessionId || null });
    }

    if (resume) {
        opened.forEach(({ id, cwd, sessionId }, n) => {
            setTimeout(() => {
                const tab = session.tabMgr.get(id);
                if (!tab) return;   // closed while we waited — nothing to launch into
                try {
                    sessionManager.launchClaude(tab, cwd, {
                        resume: true, sessionId: sessionId || null, coldFallback: false,
                    });
                } catch (_) { /* a failed launch leaves a usable shell — never fatal */ }
            }, n * LAUNCH_STAGGER_MS);
        });
    }

    try { tabPersist.saveImmediate(session.tabMgr); } catch (_) {}
    console.log(`fleet-restore: opened ${opened.length} tab(s) from ${src.from}`
        + (skipped.length ? ` (${skipped.length} skipped)` : '')
        + (resume ? ` · resuming ${opened.filter(o => o.sessionId).length}` : ''));

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
        });
        res.status(out.ok ? 200 : 409).json(out);
    });
}

module.exports = { mount, restoreFleet, pickSource, recentSessionsByCwd };
