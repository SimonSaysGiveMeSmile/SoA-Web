/**
 * TabPersist
 *
 * Saves tab configurations to disk so they survive server restarts.
 * On boot, the server reads the saved state and re-spawns shells at
 * the stored cwds. Scrollback is NOT persisted (too large / stale) —
 * only the tab identity: title, cwd, userRenamed flag, and order.
 *
 * File: ~/.soa-web/tabs.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.soa-web');
const STATE_FILE = path.join(STATE_DIR, 'tabs.json');

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

function save(tabMgr) {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        _saveTimer = null;
        _writeSync(tabMgr);
    }, DEBOUNCE_MS);
}

function saveImmediate(tabMgr) {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    _writeSync(tabMgr);
}

function _writeSync(tabMgr) {
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
        fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2) + '\n');
    } catch (_) { /* best-effort */ }
}

module.exports = { load, save, saveImmediate, STATE_FILE };
