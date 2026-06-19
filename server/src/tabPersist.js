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

// Cap per-tab scrollback at 128 KiB on disk. The in-memory ring is 256 KiB —
// halve it on disk so a session with 30 tabs doesn't push 8 MB of JSON every
// flush. The most recent bytes are what's useful for context anyway.
const MAX_SCROLLBACK_PER_TAB = 128 * 1024;

let _saveTimer = null;
const DEBOUNCE_MS = 500;

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
            data.closedByUser = true;
        }
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
        fs.renameSync(tmp, STATE_FILE);
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
    if (meta && Array.isArray(meta.tabs) && meta.tabs.length > 0) {
        return { action: 'noop', reason: 'tabs.json intact', count: meta.tabs.length };
    }
    if (meta && meta.closedByUser) {
        return { action: 'noop', reason: 'closedByUser — respecting intent' };
    }
    const sb = loadScrollback();
    if (!sb || !Array.isArray(sb.tabs) || sb.tabs.length === 0) {
        return { action: 'noop', reason: 'no scrollback to recover from' };
    }
    const tabs = [];
    for (const t of sb.tabs) {
        if (!t || typeof t.cwd !== 'string' || !t.cwd) continue;
        // scrollback.json carries the live title but not userRenamed; treat a
        // title that differs from the cwd basename as a user rename so custom
        // names survive, otherwise let the daemon re-derive it from the cwd.
        const base = path.basename(t.cwd);
        const renamed = !!(t.title && t.title !== base);
        tabs.push({ title: renamed ? t.title : null, cwd: t.cwd, userRenamed: renamed });
    }
    if (tabs.length === 0) {
        return { action: 'noop', reason: 'scrollback had no usable cwds' };
    }
    try {
        ensureDir();
        const data = { savedAt: new Date().toISOString(), tabs, recoveredFrom: 'scrollback' };
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
        fs.renameSync(tmp, STATE_FILE);
        _liveTabsSeen = true; // we now hold a real list; protect it from here on
        return { action: 'recovered', count: tabs.length };
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
        const data = { savedAt: new Date().toISOString(), tabs };
        const tmp = SCROLLBACK_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, SCROLLBACK_FILE);
    } catch (_) { /* best-effort */ }
}

module.exports = {
    load, loadScrollback, loadSession, saveSession,
    save, saveImmediate, saveAll, reconcileTabsFromScrollback,
    STATE_FILE, SCROLLBACK_FILE, SESSION_FILE,
    // test hook: reset the per-process "have we seen tabs" latch
    _resetLiveTabsSeen: () => { _liveTabsSeen = false; },
};
