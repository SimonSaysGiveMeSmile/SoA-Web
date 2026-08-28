/**
 * TabPersist
 *
 * Saves tab state to disk so context survives server restarts AND browser
 * crashes. Three files, deliberately separate so a corrupt scrollback blob
 * can't take down the cheap metadata or session restore:
 *
 *   ~/.soa-web/tabs.json        — title, cwd, userRenamed, order. Cheap.
 *                                 Saved on every change (debounced 500ms).
 *   ~/.soa-web/scrollback.json  — raw PTY bytes per tab, indexed positionally
 *                                 to tabs.json. Saved every 5 minutes by the
 *                                 server, and one final time on shutdown.
 *   ~/.soa-web/session.json     — primary session {id, token}, re-seated into
 *                                 SessionStore on boot so the existing browser
 *                                 cookie still resolves to a Session.
 *
 * On boot the server reads session.json first to seat the same session in
 * the in-memory store under the same token, then re-spawns shells at the
 * stored cwds and seeds each tab's scrollback ring buffer with the saved
 * bytes plus a divider — the user reconnects and lands on the same view
 * they left, with a fresh shell underneath.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { STATE_DIR } = require('./stateDir');
const STATE_FILE = path.join(STATE_DIR, 'tabs.json');
const SCROLLBACK_FILE = path.join(STATE_DIR, 'scrollback.json');
const SESSION_FILE = path.join(STATE_DIR, 'session.json');
// Protected copy of the last HEALTHY tab list. Written only when we persist a
// real fleet (≥ MIN_HEALTHY_TABS), so a fleet *collapse* — tabs.json shrinking
// to a lone default shell, the signature that lost the fleet on 2026-08-06 —
// can never overwrite it. reconcileTabs() restores from here on the next boot.
// Unlike scrollback.json this survives the same incident that clobbers tabs.json.
const LASTGOOD_FILE = path.join(STATE_DIR, 'tabs.json.lastgood');
// A real session has ≥2 tabs; a single tab (usually the state-dir default shell)
// is the collapse signature, not a fleet. Recovery triggers at/below this.
const MIN_HEALTHY_TABS = 2;
// Deep-history ring of timestamped healthy snapshots (tabs.json.bak-*), capped.
const MAX_TAB_BACKUPS = 12;
const ROTATE_MS = 5 * 60 * 1000;

// Cap per-tab scrollback at 128 KiB on disk. The in-memory ring is 256 KiB —
// halve it on disk so a session with 30 tabs doesn't push 8 MB of JSON every
// flush. The most recent bytes are what's useful for context anyway.
const MAX_SCROLLBACK_PER_TAB = 128 * 1024;

let _saveTimer = null;
const DEBOUNCE_MS = 500;

// Shrink guard window: for this long after boot, refuse to overwrite tabs.json
// (or scrollback.json) with a DRASTICALLY smaller tab set unless the user
// explicitly closed that many tabs. This is the backstop for the boot race
// that lost the fleet twice (2026-06-29, 2026-07-08): persistence is
// last-writer-wins across sessions, so a client that binds right after boot
// with 1-2 fresh tabs — before the fleet rehydrated anywhere — used to persist
// its tiny list straight over the 26-tab file. Explicit user closes are
// reported via noteUserClose() from the CLOSE_TAB input path, so a genuine
// "close most of my tabs" flurry still persists even inside the window.
const SHRINK_GUARD_MS = () => parseInt(process.env.SOA_WEB_TAB_SHRINK_GUARD_MS || String(10 * 60 * 1000), 10);
const _bootAt = Date.now();
let _userCloses = 0;
function noteUserClose() { _userCloses++; }

// A shrink is suspicious when it's early, drastic (below half), and larger
// than what the user's explicit closes account for.
function _shrinkRefused(kind, priorCount, nextCount) {
    const uptimeMs = Date.now() - _bootAt;
    if (uptimeMs >= SHRINK_GUARD_MS()) return false;
    if (nextCount >= Math.ceil(priorCount / 2)) return false;
    if (priorCount - nextCount <= _userCloses) return false;
    console.log(`tabPersist: refused ${kind} shrink ${priorCount} → ${nextCount} at ${Math.round(uptimeMs / 1000)}s after boot (${_userCloses} user close(s) seen) — clobber guard`);
    return true;
}

// Has this process ever held a real (non-empty) tab list? Distinguishes a
// genuine user "close-all" (after having had tabs) from a *transient/pristine*
// empty list — e.g. the primary session re-seated empty on boot, or a WS client
// that binds before restore-on-connect runs. Only the former should be allowed
// to write an empty tabs.json over a good one; the latter is the clobber that
// lost the fleet (empty tabs.json + full scrollback.json) and forced a manual
// soa-relaunch. Set true the first time we persist a non-empty list (or recover
// one), so close-all still persists while a transient empty never clobbers.
let _liveTabsSeen = false;

function ensureDir() {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function load() {
    try {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (!Array.isArray(data.tabs)) return null;
        return data;
    } catch (_) {
        return null;
    }
}

function loadScrollback() {
    try {
        const raw = fs.readFileSync(SCROLLBACK_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (!Array.isArray(data.tabs)) return null;
        return data;
    } catch (_) {
        return null;
    }
}

function loadSession() {
    try {
        const raw = fs.readFileSync(SESSION_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (!data || typeof data.token !== 'string' || typeof data.id !== 'string') return null;
        return data;
    } catch (_) {
        return null;
    }
}

function saveSession({ id, token }) {
    try {
        ensureDir();
        fs.writeFileSync(
            SESSION_FILE,
            JSON.stringify({ id, token, savedAt: new Date().toISOString() }, null, 2) + '\n',
            { mode: 0o600 },
        );
    } catch (_) { /* best-effort */ }
}

function loadLastGood() {
    try {
        const data = JSON.parse(fs.readFileSync(LASTGOOD_FILE, 'utf8'));
        if (!Array.isArray(data.tabs)) return null;
        return data;
    } catch (_) {
        return null;
    }
}

// Persist the protected healthy snapshot. Only ever called with a real (≥2 tab)
// list, so a 1-tab collapse or empty write can never erase it. Also rotates a
// capped, throttled ring of timestamped backups for deeper point-in-time history.
let _lastRotateAt = 0;
function _writeLastGood(data) {
    try {
        ensureDir();
        const blob = JSON.stringify(data, null, 2) + '\n';
        const tmp = LASTGOOD_FILE + '.tmp';
        fs.writeFileSync(tmp, blob);
        fs.renameSync(tmp, LASTGOOD_FILE);
        const now = Date.now();
        if (now - _lastRotateAt >= ROTATE_MS) {
            _lastRotateAt = now;
            const stamp = new Date(now).toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
            try { fs.writeFileSync(path.join(STATE_DIR, `tabs.json.bak-${stamp}`), blob); } catch (_) {}
            try {
                const baks = fs.readdirSync(STATE_DIR).filter(f => /^tabs\.json\.bak-/.test(f)).sort();
                for (let i = 0; i < baks.length - MAX_TAB_BACKUPS; i++) {
                    fs.unlinkSync(path.join(STATE_DIR, baks[i]));
                }
            } catch (_) {}
        }
    } catch (_) { /* best-effort */ }
}

function save(tabMgr) {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        _saveTimer = null;
        _writeMetaSync(tabMgr);
    }, DEBOUNCE_MS);
}

function saveImmediate(tabMgr) {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    _writeMetaSync(tabMgr);
}

// Full flush: metadata + scrollback. Called by the periodic interval and on
// graceful shutdown. Atomic via tmp + rename so a crash mid-write can't leave
// a half-written blob — the prior file stays usable.
function saveAll(tabMgr) {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    _writeMetaSync(tabMgr);
    _writeScrollbackSync(tabMgr);
}

function _writeMetaSync(tabMgr) {
    try {
        ensureDir();
        const tabs = [];
        for (const id of tabMgr.order) {
            const tab = tabMgr.tabs.get(id);
            if (!tab) continue;
            tabs.push({
                title: tab.userRenamed ? tab.title : null,
                cwd: tab.cwd,
                userRenamed: tab.userRenamed,
            });
        }
        const data = { savedAt: new Date().toISOString(), tabs };
        // ANTI-CLOBBER (shrink guard): early after boot, never let a much
        // smaller list replace a bigger saved fleet without matching explicit
        // user closes. Applies to the empty case too — the specific guards
        // below stay as after-window backstops.
        {
            const prior = load();
            if (prior && Array.isArray(prior.tabs) && prior.tabs.length > 0 && !prior.closedByUser
                && _shrinkRefused('tabs.json', prior.tabs.length, tabs.length)) {
                return;
            }
        }
        if (tabs.length > 0) {
            // Real list → remember it, and never carry a stale close-all marker.
            _liveTabsSeen = true;
        } else if (!_liveTabsSeen) {
            // ANTI-CLOBBER: we've never seen tabs this process, so an empty list
            // here is transient (pristine boot / pre-restore bind), NOT a user
            // action. Refuse to overwrite a good tabs.json — this is the exact
            // write that lost the fleet (empty tabs.json beside a full
            // scrollback.json). If the on-disk list is already empty/absent
            // there's nothing to protect, so fall through and write.
            const prior = load();
            if (prior && Array.isArray(prior.tabs) && prior.tabs.length > 0 && !prior.closedByUser) {
                console.log('tabPersist: refused empty tabs.json write over', prior.tabs.length, 'saved tab(s) (transient empty, no live tabs seen) — clobber guard');
                return;
            }
        } else {
            // _liveTabsSeen && empty → genuine user close-all. Record intent so
            // boot/self-heal recovery won't resurrect a fleet the user retired.
            // EXCEPT: never tombstone a tabs.json that was just recovered from
            // scrollback and not yet re-persisted by a real tab — a transient
            // empty in that window (e.g. a probe/second session) would wrongly
            // mark the fleet user-closed and block self-heal on the next boot.
            const prior = load();
            if (prior && prior.recoveredFrom) {
                console.log(`tabPersist: refused close-all tombstone over a ${prior.recoveredFrom}-recovered tabs.json (transient empty post-recovery)`);
                return;
            }
            data.closedByUser = true;
        }
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
        fs.renameSync(tmp, STATE_FILE);
        // Snapshot the protected copy only for a real fleet, so a later collapse
        // can self-heal from it. A lone/empty list never touches lastgood.
        if (tabs.length >= MIN_HEALTHY_TABS) _writeLastGood(data);
    } catch (_) { /* best-effort */ }
}

// Boot-time fleet recovery. If tabs.json is empty/missing — but NOT because the
// user closed everything (closedByUser) — rebuild the tab list from
// scrollback.json, whose per-tab {title, cwd} survives the clobber (its flush is
// guarded by persistableSession). The daemon's restore-on-connect then re-seeds
// each tab's scrollback and auto-resumes Claude, so the fleet comes back with no
// manual soa-relaunch. Idempotent and safe: a no-op when tabs are present or the
// user intentionally cleared them. Returns a small report for the boot log.
function reconcileTabsFromScrollback() {
    const meta = load();
    // Respect an explicit user close-all above all else.
    if (meta && meta.closedByUser) {
        return { action: 'noop', reason: 'closedByUser — respecting intent' };
    }
    const metaCount = (meta && Array.isArray(meta.tabs)) ? meta.tabs.length : 0;
    // A real fleet (≥2 tabs) is ALWAYS trusted as-is: backups can legitimately
    // lag a user who just closed tabs, so we never second-guess a multi-tab
    // list. Recovery fires only on the collapse signature — empty (0) or a lone
    // tab (1) — which no normal multi-project session sits at.
    if (metaCount >= MIN_HEALTHY_TABS) {
        return { action: 'noop', reason: 'tabs.json intact', count: metaCount };
    }

    // Collapsed. Rebuild from the richest known-good source. Prefer lastgood — a
    // real persisted list that, unlike scrollback.json, is never overwritten by
    // the same collapse that clobbered tabs.json. Fall back to scrollback (its
    // per-tab cwd survives an empty tabs.json) when no lastgood exists yet, e.g.
    // the first boot after this upgrade.
    const lastgood = loadLastGood();
    const lgCount = (lastgood && Array.isArray(lastgood.tabs)) ? lastgood.tabs.length : 0;
    const sb = loadScrollback();
    const sbCount = (sb && Array.isArray(sb.tabs)) ? sb.tabs.length : 0;

    let tabs = null, from = null;
    if (lgCount >= MIN_HEALTHY_TABS) {
        tabs = lastgood.tabs
            .filter(t => t && typeof t.cwd === 'string' && t.cwd)
            .map(t => ({ title: t.userRenamed ? t.title : null, cwd: t.cwd, userRenamed: !!t.userRenamed }));
        from = 'lastgood';
    } else if (sbCount >= MIN_HEALTHY_TABS) {
        tabs = [];
        for (const t of sb.tabs) {
            if (!t || typeof t.cwd !== 'string' || !t.cwd) continue;
            // scrollback.json carries the live title but not userRenamed; treat a
            // title that differs from the cwd basename as a user rename so custom
            // names survive, otherwise let the daemon re-derive it from the cwd.
            const base = path.basename(t.cwd);
            const renamed = !!(t.title && t.title !== base);
            tabs.push({ title: renamed ? t.title : null, cwd: t.cwd, userRenamed: renamed });
        }
        from = 'scrollback';
    }
    if (!tabs || tabs.length === 0) {
        return { action: 'noop', reason: metaCount ? 'collapsed but no richer source' : 'no scrollback to recover from', count: metaCount };
    }
    // Union in the collapsed file's lone tab if it names a distinct real cwd, so
    // a genuinely-new tab that outlived the collapse isn't dropped on recovery.
    if (meta && Array.isArray(meta.tabs)) {
        const have = new Set(tabs.map(t => t.cwd));
        for (const t of meta.tabs) {
            if (t && typeof t.cwd === 'string' && t.cwd && !have.has(t.cwd)) {
                tabs.push({ title: t.userRenamed ? t.title : null, cwd: t.cwd, userRenamed: !!t.userRenamed });
                have.add(t.cwd);
            }
        }
    }
    try {
        ensureDir();
        const data = { savedAt: new Date().toISOString(), tabs, recoveredFrom: from };
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
        fs.renameSync(tmp, STATE_FILE);
        // NOTE: deliberately do NOT set _liveTabsSeen here. Recovery already
        // rewrote tabs.json on disk (now non-empty + recoveredFrom), which the
        // existing clobber guard protects via load(). Latching the process-global
        // _liveTabsSeen at boot would let a LATER transient-empty session write a
        // closedByUser tombstone over this recovered fleet (cross-session poison)
        // — the recurring "self-heal recovered but the next boot won't". The latch
        // is earned legitimately the first time a real tab is persisted.
        return { action: 'recovered', count: tabs.length, from, over: metaCount };
    } catch (e) {
        return { action: 'error', reason: (e && e.message) || String(e) };
    }
}

function _writeScrollbackSync(tabMgr) {
    try {
        ensureDir();
        const tabs = [];
        for (const id of tabMgr.order) {
            const tab = tabMgr.tabs.get(id);
            if (!tab) continue;
            let snap = tab.scrollback ? tab.scrollback.snapshot() : '';
            if (snap.length > MAX_SCROLLBACK_PER_TAB) {
                snap = snap.slice(snap.length - MAX_SCROLLBACK_PER_TAB);
            }
            tabs.push({ title: tab.title, cwd: tab.cwd, scrollback: snap });
        }
        // ANTI-CLOBBER (symmetric to _writeMetaSync's guard): scrollback.json is
        // the self-heal recovery source — reconcileTabsFromScrollback() rebuilds
        // the whole fleet from it — so a transient empty list must NEVER overwrite
        // a good one. If we've never held real tabs this process AND the on-disk
        // file still has tabs, refuse: the empty is a pristine / pre-restore bind,
        // not a real close-all. (Once _liveTabsSeen, a genuine close-all IS
        // written, mirroring the metadata path.) Without this guard a periodic
        // saveAll() on an empty session could orphan tabs.json beside an emptied
        // scrollback.json — the exact "fleet lost, nothing to recover from" state.
        if (tabs.length === 0 && !_liveTabsSeen) {
            const prior = loadScrollback();
            if (prior && Array.isArray(prior.tabs) && prior.tabs.length > 0) {
                console.log('tabPersist: refused empty scrollback.json write over', prior.tabs.length, 'saved tab(s) (transient empty, no live tabs seen) — clobber guard');
                return;
            }
        }
        // Same shrink guard as the metadata path: scrollback.json is the
        // recovery source, so an early drastic shrink would erase exactly what
        // reconcileTabsFromScrollback() needs to bring the fleet back.
        {
            const prior = loadScrollback();
            if (prior && Array.isArray(prior.tabs) && prior.tabs.length > 0
                && _shrinkRefused('scrollback.json', prior.tabs.length, tabs.length)) {
                return;
            }
        }
        const data = { savedAt: new Date().toISOString(), tabs };
        const tmp = SCROLLBACK_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, SCROLLBACK_FILE);
    } catch (_) { /* best-effort */ }
}

// Multiset of live (non-exited) tab cwds across the given sessions — the
// "already running" side of restore-on-connect. Counted fleet-wide, not per
// session: the saved list describes the whole fleet, and the fleet may be alive
// in ANOTHER session (a lapsed cookie, a phone bound to a fresh token session).
// Re-opening those here `claude --resume`s agents that are already running —
// the 2026-08-25 duplication (16 agents, 8 of them doubled or tripled).
function liveCwdCounts(sessionsIterable) {
    const counts = new Map();
    for (const s of sessionsIterable || []) {
        if (!s || !s.tabMgr) continue;
        for (const id of s.tabMgr.order) {
            const t = s.tabMgr.tabs.get(id);
            if (t && t.cwd && !t.exited) counts.set(t.cwd, (counts.get(t.cwd) || 0) + 1);
        }
    }
    return counts;
}

// Which saved entries to (re)open given the live multiset. Each live tab consumes
// one matching saved entry, so a project with several saved tabs still restores
// fully when only some are alive. Pure; does not mutate `liveByCwd`.
function planRestore(savedTabs, liveByCwd) {
    const remaining = new Map(liveByCwd || []);
    const open = [];
    let skipped = 0;
    (savedTabs || []).forEach((entry, index) => {
        const have = (entry && remaining.get(entry.cwd)) || 0;
        if (have > 0) { remaining.set(entry.cwd, have - 1); skipped++; return; }
        open.push({ entry, index });
    });
    return { open, skipped };
}

module.exports = {
    liveCwdCounts, planRestore,
    load, loadScrollback, loadLastGood, loadSession, saveSession,
    save, saveImmediate, saveAll, reconcileTabsFromScrollback,
    noteUserClose,
    STATE_FILE, SCROLLBACK_FILE, SESSION_FILE,
    // test hook: reset the per-process "have we seen tabs" latch
    _resetLiveTabsSeen: () => { _liveTabsSeen = false; },
};
