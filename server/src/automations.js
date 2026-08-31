/**
 * automations.js — one switchboard for everything that can type into a tab on
 * its own, plus the attribution dividers that make such input visible.
 *
 * Until now each automation had its own control surface: rehydrate auto-resume
 * and boot-resume obeyed only env vars in the launchd plist, autopilot had its
 * own widget, the manager CLI its license, and the optional launchd
 * supervisors their own kill-switches — nothing showed the whole picture, and
 * injected input rendered exactly like the user's own typing ("the manager
 * keeps sending weird commands", 2026-08-27). This module owns:
 *
 *   - automations.json-backed overrides for autoResume / bootResume /
 *     attribution (the env vars stay as defaults, so existing installs keep
 *     behaving until the user flips a switch in the MANAGER widget);
 *   - announce(): the dim `── label ──` divider written to a tab's DISPLAY
 *     (scrollback + every connected client), never to the PTY's stdin;
 *   - /api/automations: the MANAGER sidebar widget's read/write surface.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { STATE_DIR } = require('./stateDir');
const entitlements = require('./entitlements');

const FILE = path.join(STATE_DIR, 'automations.json');
const TOGGLES = ['autoResume', 'bootResume', 'attribution'];

function _load() {
    try { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); return d && typeof d === 'object' ? d : {}; }
    catch (_) { return {}; }
}
function _save(st) { try { fs.writeFileSync(FILE, JSON.stringify(st, null, 2) + '\n'); } catch (_) { /* best-effort */ } }

// The pre-switchboard behaviour, unchanged: env vars decide until a toggle is set.
function _envDefault(name) {
    if (name === 'autoResume') return process.env.SOA_WEB_NO_AUTO_RESUME !== '1';
    if (name === 'bootResume') return process.env.SOA_WEB_NO_BOOT_RESUME !== '1';
    return true; // attribution
}
function enabled(name) {
    const st = _load();
    return typeof st[name] === 'boolean' ? st[name] : _envDefault(name);
}
function set(name, on) {
    if (!TOGGLES.includes(name)) return null;
    const st = _load();
    st[name] = !!on;
    _save(st);
    return st[name];
}
function toggles() {
    const out = {};
    for (const t of TOGGLES) out[t] = enabled(t);
    return out;
}

// Attribution divider, gated by its toggle. Callers pass the TabManager so
// this module stays dependency-light (no session plumbing).
function announce(tabMgr, tabId, label) {
    if (!tabMgr || typeof tabMgr.announce !== 'function' || !enabled('attribution')) return false;
    try { return tabMgr.announce(tabId, label); } catch (_) { return false; }
}

// The optional launchd supervisors (installed from deploy/launchd, not by this
// daemon). Reported read-only so the panel can say what ELSE might be typing.
const SUPERVISOR_LABELS = [
    'com.soa-web.watchdog-4010', 'com.soa-web.manager-watchdog-4010', 'com.soa-web.channels',
    'com.soa-web.heartbeat', 'com.soa-web.nudge-stale-4010', 'com.soa-web.effort-4010',
    'com.soa-web.usage-alert', 'com.soa-web.usage-throttle', 'com.soa-web.fleet-loop',
];
function parseSupervisors(listOutput, labels = SUPERVISOR_LABELS) {
    const present = new Set(String(listOutput || '').split('\n')
        .map(l => l.trim().split(/\s+/).pop()).filter(Boolean));
    return labels.map(label => ({ label, installed: present.has(label) }));
}
let _supCache = { at: 0, rows: [] };
function supervisors(cb) {
    if (Date.now() - _supCache.at < 30000) return cb(_supCache.rows);
    execFile('launchctl', ['list'], { timeout: 3000 }, (err, out) => {
        const rows = err ? [] : parseSupervisors(out);
        _supCache = { at: Date.now(), rows };
        cb(rows);
    });
}

// deps.autopilot: () => autoPilot state — passed in by index.js so this module
// never requires autoPilot (which requires this module for announce()).
function mount(app, requireAuthed, deps = {}) {
    app.get('/api/automations', requireAuthed, (req, res) => {
        supervisors(rows => {
            let ap = null;
            try { ap = deps.autopilot ? deps.autopilot() : null; } catch (_) {}
            res.json({
                ok: true,
                toggles: toggles(),
                autopilot: ap && {
                    paused: !!ap.paused,
                    schedules: (ap.schedules || []).filter(s => s.enabled).length,
                    orchestrator: !!(ap.orchestrator && ap.orchestrator.enabled),
                },
                manager: { entitled: entitlements.isEnabled('manager') },
                supervisors: rows.filter(r => r.installed).map(r => r.label),
            });
        });
    });
    app.post('/api/automations', requireAuthed, (req, res) => {
        const { name, enabled: on } = req.body || {};
        const v = set(String(name || ''), !!on);
        if (v == null) return res.status(400).json({ ok: false, error: 'unknown toggle' });
        res.json({ ok: true, name, enabled: v, toggles: toggles() });
    });
}

module.exports = { enabled, set, toggles, announce, supervisors, parseSupervisors, mount, TOGGLES, SUPERVISOR_LABELS, FILE };
