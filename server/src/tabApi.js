const express = require('express');
const fs = require('fs');
const { MSG, frame } = require('./protocol');
const tabPersist = require('./tabPersist');
const envStore = require('./envStore');

function mount(app, requireAuthed, sessions) {
    const router = express.Router();

    function resolveSession(req) {
        if (req.session && req.session.tabMgr) return req.session;
        for (const s of sessions.sessions.values()) {
            if (s.tabMgr) return s;
        }
        return null;
    }

    router.get('/api/tabs', requireAuthed, (req, res) => {
        const s = resolveSession(req);
        if (!s) return res.json({ ok: true, tabs: [] });
        const tabs = s.tabMgr.list().map(t => {
            const tab = s.tabMgr.get(t.id);
            return {
                id: t.id,
                title: t.title,
                cwd: tab ? tab.cwd : null,
                exited: t.exited,
                active: s.activeTab === t.id,
            };
        });
        res.json({ ok: true, tabs });
    });

    router.post('/api/tabs', requireAuthed, (req, res) => {
        const s = resolveSession(req);
        if (!s) return res.status(503).json({ ok: false, error: 'no active session' });
        const { title, cwd } = req.body || {};
        const validCwd = cwd && fs.existsSync(cwd) ? cwd : undefined;
        const tab = s.tabMgr.open({ title: title || undefined, cwd: validCwd, env: envStore.getEnvForShell(), silent: true });
        s.activeTab = tab.id;
        s.send(frame(MSG.SNAPSHOT, {
            tabs: s.tabMgr.list(),
            activeId: tab.id,
            graveyard: s.tabMgr.graveyardList(),
        }));
        tabPersist.save(s.tabMgr);
        res.json({ ok: true, tab: { id: tab.id, title: tab.title, cwd: tab.cwd } });
    });

    router.get('/api/tabs/:id', requireAuthed, (req, res) => {
        const s = resolveSession(req);
        if (!s) return res.status(503).json({ ok: false, error: 'no active session' });
        const id = parseInt(req.params.id, 10);
        const tab = s.tabMgr.get(id);
        if (!tab) return res.status(404).json({ ok: false, error: 'tab not found' });
        const lines = parseInt(req.query.lines || '50', 10);
        const raw = tab.scrollback.snapshot();
        const tail = raw.split('\n').slice(-lines).join('\n');
        res.json({
            ok: true,
            tab: {
                id: tab.id,
                title: tab.title,
                cwd: tab.cwd,
                exited: tab.exited,
                active: s.activeTab === id,
                userRenamed: tab.userRenamed,
            },
            scrollback: tail,
        });
    });

    router.delete('/api/tabs/:id', requireAuthed, (req, res) => {
        const s = resolveSession(req);
        if (!s) return res.status(503).json({ ok: false, error: 'no active session' });
        const id = parseInt(req.params.id, 10);
        const tab = s.tabMgr.get(id);
        if (!tab) return res.status(404).json({ ok: false, error: 'tab not found' });
        s.tabMgr.close(id);
        res.json({ ok: true });
    });

    router.patch('/api/tabs/:id', requireAuthed, (req, res) => {
        const s = resolveSession(req);
        if (!s) return res.status(503).json({ ok: false, error: 'no active session' });
        const id = parseInt(req.params.id, 10);
        const tab = s.tabMgr.get(id);
        if (!tab) return res.status(404).json({ ok: false, error: 'tab not found' });
        const { title, active } = req.body || {};
        if (typeof title === 'string') {
            s.tabMgr.rename(id, title);
        }
        if (active === true) {
            s.activeTab = id;
            s.send(frame(MSG.SNAPSHOT, {
                tabs: s.tabMgr.list(),
                activeId: id,
                graveyard: s.tabMgr.graveyardList(),
            }));
        }
        res.json({ ok: true, tab: { id: tab.id, title: tab.title, cwd: tab.cwd, active: s.activeTab === id } });
    });

    router.post('/api/tabs/:id/exec', requireAuthed, (req, res) => {
        const s = resolveSession(req);
        if (!s) return res.status(503).json({ ok: false, error: 'no active session' });
        const id = parseInt(req.params.id, 10);
        const tab = s.tabMgr.get(id);
        if (!tab) return res.status(404).json({ ok: false, error: 'tab not found' });
        const { line } = req.body || {};
        if (typeof line !== 'string') return res.status(400).json({ ok: false, error: 'line is required' });
        tab.write(line + '\r');
        setTimeout(() => s.tabMgr.pokeCwd(id), 120);
        res.json({ ok: true });
    });

    router.post('/api/tabs/:id/keys', requireAuthed, (req, res) => {
        const s = resolveSession(req);
        if (!s) return res.status(503).json({ ok: false, error: 'no active session' });
        const id = parseInt(req.params.id, 10);
        const tab = s.tabMgr.get(id);
        if (!tab) return res.status(404).json({ ok: false, error: 'tab not found' });
        const { text } = req.body || {};
        if (typeof text !== 'string') return res.status(400).json({ ok: false, error: 'text is required' });
        tab.write(text);
        res.json({ ok: true });
    });

    router.post('/api/tabs/:id/resize', requireAuthed, (req, res) => {
        const s = resolveSession(req);
        if (!s) return res.status(503).json({ ok: false, error: 'no active session' });
        const id = parseInt(req.params.id, 10);
        const tab = s.tabMgr.get(id);
        if (!tab) return res.status(404).json({ ok: false, error: 'tab not found' });
        const { cols, rows } = req.body || {};
        if (!cols || !rows) return res.status(400).json({ ok: false, error: 'cols and rows required' });
        tab.resize(Math.max(2, cols | 0), Math.max(2, rows | 0));
        res.json({ ok: true });
    });

    app.use(router);
}

module.exports = { mount };
