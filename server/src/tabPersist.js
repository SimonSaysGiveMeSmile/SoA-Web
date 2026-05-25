/**
 * TabPersist
 *
 * Saves tab state to disk so context survives server restarts. Two files,
 * deliberately separate so a corrupt scrollback blob can't take down the
 * cheap metadata restore:
 *
 *   ~/.soa-web/tabs.json        — title, cwd, userRenamed, order. Cheap.
 *                                 Saved on every change (debounced 500ms).
 *   ~/.soa-web/scrollback.json  — raw PTY bytes per tab, indexed positionally
 *                                 to tabs.json. Saved every 5 minutes by the
 *                                 server, and one final time on shutdown.
 *
 * On boot, tabs respawn at their stored cwd; if a scrollback entry exists
 * for that slot it's seeded into the new tab's ring buffer with a divider
 * so the user can see the prior context but knows the process is fresh.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.soa-web');
const STATE_FILE = path.join(STATE_DIR, 'tabs.json');
const SCROLLBACK_FILE = path.join(STATE_DIR, 'scrollback.json');

// Cap per-tab scrollback at 128 KiB on disk. The in-memory ring is 256 KiB —
// halve it on disk so a session with 30 tabs doesn't push 8 MB of JSON every
// flush. The most recent bytes are what's useful for context anyway.
const MAX_SCROLLBACK_PER_TAB = 128 * 1024;

let _saveTimer = null;
const DEBOUNCE_MS = 500;

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
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
        fs.renameSync(tmp, STATE_FILE);
    } catch (_) { /* best-effort */ }
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
            tabs.push({ scrollback: snap });
        }
        const data = { savedAt: new Date().toISOString(), tabs };
        const tmp = SCROLLBACK_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, SCROLLBACK_FILE);
    } catch (_) { /* best-effort */ }
}

module.exports = {
    load, loadScrollback, save, saveImmediate, saveAll,
    STATE_FILE, SCROLLBACK_FILE,
};
