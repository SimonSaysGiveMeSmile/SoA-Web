const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { stateFile } = require('./stateDir');
const { submitToTab } = require('./sessionManager');
const { frame, MSG } = require('./protocol');
const envStore = require('./envStore');
const tabPersist = require('./tabPersist');

const TITLE = 'Voice manager';
const CWD = stateFile('voice-manager');
const LAUNCHER = path.resolve(__dirname, '../../scripts/voice-manager.cjs');
function launchOptions(cwd) {
    return cwd === CWD ? { command: process.execPath, args: [LAUNCHER] } : {};
}

function mount(app, requireAuthed, browserAllowed) {
    const gate = (req, res, next) => {
        if (!browserAllowed(req)) return res.status(403).json({ ok: false, error: 'request origin not allowed' });
        next();
    };
    app.post('/api/voice/chat/session', gate, requireAuthed, (req, res) => {
        const s = req.session;
        if (!s?.tabMgr) return res.status(503).json({ ok: false, error: 'Pair with your desktop first.' });
        const mgr = s.tabMgr;
        let tab = mgr.order.map(id => mgr.get(id)).find(t => t && !t.exited && t.cwd === CWD);
        const created = !tab;
        try {
            if (!tab) {
                fs.mkdirSync(CWD, { recursive: true });
                tab = mgr.open({ title: TITLE, cwd: CWD, env: envStore.getEnvForShell(), ...launchOptions(CWD) });
                tabPersist.save(mgr);
            }
            if (tab.exited) throw new Error('Could not start the manager terminal.');
            const tabs = mgr.list();
            s.send(frame(MSG.SNAPSHOT, { tabs, activeId: s.activeTab }));
            res.json({ ok: true, created, tab: { id: tab.id, title: tab.title }, tabs });
        } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
    });
    app.post('/api/voice/chat/send', gate, requireAuthed, express.json({ limit: '32kb' }), (req, res) => {
        const id = Number(req.body?.id);
        const text = req.body?.text;
        const tab = Number.isInteger(id) && req.session?.tabMgr?.get(id);
        if (!tab || tab.exited) return res.status(404).json({ ok: false, error: 'That terminal has closed. Choose a terminal again.' });
        if (typeof text !== 'string' || !text.trim() || text.length > 16000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text))
            return res.status(400).json({ ok: false, error: 'Message is empty, too long, or contains control characters.' });
        // Bracketed paste keeps multiline messages as one prompt; shared FIFO
        // keeps a second send from landing before the first Enter.
        submitToTab(tab, '\x1b[200~' + text.trim() + '\x1b[201~');
        res.json({ ok: true });
    });
}
module.exports = { mount, launchOptions, CWD, TITLE };
