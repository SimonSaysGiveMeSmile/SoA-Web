const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { MSG, frame } = require('./protocol');
const tabPersist = require('./tabPersist');
const envStore = require('./envStore');

// ── Per-project icon (dashboard tile identification) ───────────────────────
// If a project folder carries a recognizable icon/logo, the dashboard shows it
// on that tab's tile so the fleet is scannable by sight, not just title. We
// probe the project root plus a few conventional asset dirs in priority order
// and serve the first match. Results — INCLUDING "no icon" (negative cache) —
// are memoized per cwd so the tile grid never re-stats the disk on a repaint.
const ICON_CANDIDATES = [
    'icon.svg', 'icon.png', 'icon.webp', 'icon.jpg', 'icon.jpeg', 'icon.ico', 'icon.gif',
    'logo.svg', 'logo.png', 'logo.webp', 'logo.jpg', 'logo.jpeg',
    'favicon.svg', 'favicon.ico', 'favicon.png',
    'app-icon.png', 'appicon.png', 'apple-touch-icon.png',
    'public/favicon.ico', 'public/favicon.svg', 'public/favicon.png',
    'public/icon.svg', 'public/icon.png', 'public/logo.svg', 'public/logo.png',
    'public/apple-touch-icon.png',
    'assets/icon.png', 'assets/icon.svg', 'assets/logo.png', 'assets/logo.svg',
    'static/favicon.ico', 'static/icon.png', 'static/logo.png',
    'src/favicon.ico', 'src/assets/logo.svg', 'src/assets/logo.png',
    'web/public/favicon.ico', 'web/public/icon.png',
    'assets/favicon.ico', 'assets/favicon.png',
    'images/logo.png', 'images/icon.png', 'img/logo.png', 'img/icon.png',
    'docs/logo.png', 'resources/icon.png',
];
const ICON_MIME = {
    '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.gif': 'image/gif',
};
const _iconCache = new Map(); // cwd -> { file: string|null, at: number }
const ICON_CACHE_MS = 60 * 1000;
const ICON_MAX_BYTES = 2 * 1024 * 1024;

function resolveProjectIcon(cwd) {
    if (!cwd || typeof cwd !== 'string') return null;
    const hit = _iconCache.get(cwd);
    if (hit && (Date.now() - hit.at) < ICON_CACHE_MS) return hit.file;
    let found = null;
    for (const rel of ICON_CANDIDATES) {
        const p = path.join(cwd, rel);
        // Candidates are a fixed allowlist (no user input), but normalize anyway
        // so nothing can resolve outside the project root.
        if (p !== cwd && !p.startsWith(cwd + path.sep)) continue;
        try {
            const st = fs.statSync(p); // follows symlinks intentionally
            if (st.isFile() && st.size > 0 && st.size <= ICON_MAX_BYTES) { found = p; break; }
        } catch (_) { /* missing — try next candidate */ }
    }
    _iconCache.set(cwd, { file: found, at: Date.now() });
    return found;
}

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

    // Serve the project icon for a tab's cwd (or 404 if the folder has none).
    // The dashboard renders <img src> against this and reveals it only on load,
    // so a 404 is the normal, silent "this project has no icon" case.
    router.get('/api/tabs/:id/icon', requireAuthed, (req, res) => {
        const s = resolveSession(req);
        if (!s) return res.status(404).end();
        const id = parseInt(req.params.id, 10);
        const tab = s.tabMgr.get(id);
        if (!tab) return res.status(404).end();
        const file = resolveProjectIcon(tab.cwd);
        if (!file) return res.status(404).end();
        const mime = ICON_MIME[path.extname(file).toLowerCase()];
        if (!mime) return res.status(404).end();
        res.type(mime);
        res.set('Cache-Control', 'private, max-age=120');
        res.sendFile(file, (err) => { if (err && !res.headersSent) res.status(404).end(); });
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

    // Directory listing for the "open new tab in folder" picker. Defaults to
    // $HOME, can navigate anywhere the server process can read. Hidden entries
    // are filtered unless ?hidden=1. Symlinks to dirs are followed for the
    // is-directory check via statSync (lstatSync would mark the link itself).
    router.get('/api/browse', requireAuthed, (req, res) => {
        const requested = typeof req.query.path === 'string' && req.query.path
            ? req.query.path
            : os.homedir();
        const showHidden = req.query.hidden === '1';
        let resolved;
        try {
            resolved = path.resolve(requested.replace(/^~(?=$|\/)/, os.homedir()));
        } catch (_) {
            return res.status(400).json({ ok: false, error: 'invalid path' });
        }
        let entries;
        try {
            entries = fs.readdirSync(resolved, { withFileTypes: true });
        } catch (err) {
            return res.status(400).json({ ok: false, error: err.code === 'ENOENT'
                ? 'not found' : err.code === 'EACCES'
                ? 'permission denied' : err.message });
        }
        const dirs = [];
        for (const e of entries) {
            if (!showHidden && e.name.startsWith('.')) continue;
            let isDir = e.isDirectory();
            if (!isDir && e.isSymbolicLink()) {
                try { isDir = fs.statSync(path.join(resolved, e.name)).isDirectory(); }
                catch (_) { /* dangling link */ }
            }
            if (isDir) dirs.push(e.name);
        }
        dirs.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        const parent = path.dirname(resolved);
        res.json({
            ok: true,
            path: resolved,
            parent: parent === resolved ? null : parent,
            home: os.homedir(),
            dirs,
        });
    });

    app.use(router);
}

module.exports = { mount };
