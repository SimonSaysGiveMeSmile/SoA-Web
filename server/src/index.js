/**
 * SoA-Web server entry.
 *
 * HTTP serves the static browser bundle (web/public) + a tiny API (login,
 * logout, health). WebSocket at /ws owns the realtime channel: frames go
 * through the shared ./protocol.js schema, and every connected socket is
 * bound to one Session holding that browser's PTY pool.
 *
 * Configuration:
 *   SOA_WEB_HOST       bind host (default 127.0.0.1; set 0.0.0.0 for LAN/cloud)
 *   SOA_WEB_PORT       bind port (default 7332)
 *   SOA_WEB_AUTH       open | shared | none (see ./auth.js)
 *   SOA_WEB_PASSWORD   shared-secret password when SOA_WEB_AUTH=shared
 *   SOA_WEB_SIGN_KEY   HMAC key for the auth cookie (random per-process if unset)
 *   SOA_WEB_SHELL      shell binary; defaults to $SHELL or /bin/bash
 *   SOA_WEB_SESSION_TTL_MS  idle timeout for sessions (default 6h)
 *   SOA_WEB_DEV=1      dev mode — sends cache-control: no-store on static assets
 */

const http = require('http');
const path = require('path');
const fs   = require('fs');

const WebSocket = require('ws');
const express   = require('express');

const { MSG, INPUT_KIND, frame, parse } = require('./protocol');
const { SessionStore } = require('./sessionStore');
const { TabManager }   = require('./tabManager');
const auth             = require('./auth');
const sysinfo          = require('./sysinfo');
const pairing          = require('./pairing');

const HOST = process.env.SOA_WEB_HOST || '127.0.0.1';
const PORT = parseInt(process.env.SOA_WEB_PORT || '7332', 10);
const DEV  = process.env.SOA_WEB_DEV === '1';
const SESSION_TTL_MS = parseInt(process.env.SOA_WEB_SESSION_TTL_MS || String(1000 * 60 * 60 * 6), 10);

const AUTH_MODE  = auth.resolveMode();
const PASSWORD   = auth.resolvePassword();
const SIGN_KEY   = auth.resolveSignKey();
const SECURE_COOKIE = process.env.SOA_WEB_SECURE_COOKIE === '1';

function assertSafeConfig() {
    const loopback = HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost';
    if (AUTH_MODE === 'open' && !loopback) {
        console.error('\nREFUSING TO START: SOA_WEB_AUTH=open binds a shell to', HOST);
        console.error('Set SOA_WEB_PASSWORD (shared-secret mode) or SOA_WEB_AUTH=none if an upstream proxy handles auth.\n');
        process.exit(2);
    }
    if (AUTH_MODE === 'shared' && !PASSWORD) {
        console.error('\nREFUSING TO START: SOA_WEB_AUTH=shared requires SOA_WEB_PASSWORD.\n');
        process.exit(2);
    }
}

assertSafeConfig();

const sessions = new SessionStore({ idleTtlMs: SESSION_TTL_MS });
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

const PUBLIC_DIR = path.resolve(__dirname, '../../web/public');
const CONFIG_SNIPPET = `window.__SOA_WEB__ = ${JSON.stringify({ auth: AUTH_MODE, protocol: 1 })};`;

// ── Middleware: attach session ──────────────────────────────────────────
function currentSession(req) {
    const raw = auth.readCookie(req.headers.cookie || '', auth.COOKIE_NAME);
    if (!raw) return null;
    const decoded = auth.verify(raw, SIGN_KEY);
    if (!decoded) return null;
    try {
        const payload = JSON.parse(Buffer.from(decoded, 'base64url').toString('utf8'));
        if (!payload || !payload.sub) return null;
        return sessions.getByToken(payload.sub);
    } catch (_) { return null; }
}

function requireAuthed(req, res, next) {
    if (AUTH_MODE === 'open' || AUTH_MODE === 'none') {
        // Auto-provision a session so the browser has a stable identity.
        let s = currentSession(req);
        if (!s) {
            s = sessions.create();
            const token = auth.issue(s.token, SIGN_KEY);
            res.setHeader('Set-Cookie', auth.makeCookie(token, { secure: SECURE_COOKIE }));
        }
        req.session = s;
        s.touch();
        return next();
    }

    const s = currentSession(req);
    if (!s) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
    req.session = s;
    s.touch();
    next();
}

// ── API ─────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
    if (AUTH_MODE === 'open' || AUTH_MODE === 'none') {
        const s = sessions.create();
        const token = auth.issue(s.token, SIGN_KEY);
        res.setHeader('Set-Cookie', auth.makeCookie(token, { secure: SECURE_COOKIE }));
        return res.json({ ok: true, mode: AUTH_MODE });
    }
    const supplied = (req.body && typeof req.body.password === 'string') ? req.body.password : '';
    if (!auth.constantTimeEq(supplied, PASSWORD)) {
        return res.status(401).json({ ok: false, error: 'bad-password' });
    }
    const s = sessions.create();
    const token = auth.issue(s.token, SIGN_KEY);
    res.setHeader('Set-Cookie', auth.makeCookie(token, { secure: SECURE_COOKIE }));
    res.json({ ok: true, mode: AUTH_MODE });
});

app.post('/api/logout', (req, res) => {
    const s = currentSession(req);
    if (s) sessions.destroy(s);
    res.setHeader('Set-Cookie', auth.clearCookie({ secure: SECURE_COOKIE }));
    res.json({ ok: true });
});

app.get('/api/ping', (req, res) => {
    res.json({ ok: true, name: 'soa-web', protocol: 1, auth: AUTH_MODE });
});

app.get('/api/me', (req, res) => {
    const s = currentSession(req);
    res.json({ ok: true, authed: !!s, auth: AUTH_MODE });
});

// ── Sidebar + mobile-pairing routes ─────────────────────────────────────
sysinfo.mount(app, requireAuthed);
const pair = new pairing.PairingManager({ port: PORT });
pairing.mount(app, requireAuthed, pair);

// ── Static ──────────────────────────────────────────────────────────────
app.get('/_config.js', (req, res) => {
    res.type('application/javascript; charset=utf-8');
    if (DEV) res.set('cache-control', 'no-store');
    res.send(CONFIG_SNIPPET);
});

// Serve /protocol.js to the browser so the client can reuse the same schema.
app.get('/_protocol.js', (req, res) => {
    const file = path.join(__dirname, 'protocol.js');
    fs.readFile(file, 'utf8', (err, src) => {
        if (err) { res.status(500).end(); return; }
        res.type('application/javascript; charset=utf-8');
        if (DEV) res.set('cache-control', 'no-store');
        // Convert the CommonJS module into a tiny ES-module-like global so the
        // browser can `import('./_protocol.js')`.
        const esm = src.replace(/module\.exports\s*=\s*\{([\s\S]*?)\};?\s*$/m, (_m, body) => `export { ${body.trim()} };`);
        res.send(esm);
    });
});

app.use((req, res, next) => {
    if (DEV) res.set('cache-control', 'no-store');
    next();
});

app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'] }));

// SPA fallback — any unknown GET serves index.html so client-side routes work.
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/_')) return next();
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ── HTTP + WS server ────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }

    const s = ((req) => {
        const raw = auth.readCookie(req.headers.cookie || '', auth.COOKIE_NAME);
        if (!raw) return null;
        const decoded = auth.verify(raw, SIGN_KEY);
        if (!decoded) return null;
        try {
            const payload = JSON.parse(Buffer.from(decoded, 'base64url').toString('utf8'));
            return sessions.getByToken(payload.sub);
        } catch (_) { return null; }
    })(req);

    if (!s) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }

    wss.handleUpgrade(req, socket, head, ws => onWsConnect(ws, s));
});

function onWsConnect(ws, session) {
    session.attachSocket(ws);
    session.touch();
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    if (!session.tabs) session.tabs = [];
    if (!session.tabMgr) {
        session.tabMgr = new TabManager({
            onData: (tabId, data) => session.send(frame(MSG.TERM_DATA, { id: tabId, data })),
            onTabsChange: list => {
                // If the active tab just went away, pick the next available
                // one so HELLO after a reload doesn't point at a dead id.
                if (session.activeTab && !list.some(t => t.id === session.activeTab)) {
                    session.activeTab = (list[0] && list[0].id) || 0;
                }
                session.send(frame(MSG.SNAPSHOT, { tabs: list, activeId: session.activeTab || 0 }));
            },
            onExit: (tabId, code) => session.send(frame(MSG.TERM_EXIT, { id: tabId, code })),
        });
    }

    try {
        const tabList = session.tabMgr.list();
        // Replay scrollback right after the tab list so a reloading browser
        // catches up on everything it missed — tabs, which one was active,
        // and the accumulated output for each — before any new term-data
        // frames arrive. This is what makes a page refresh non-destructive.
        const replay = tabList
            .map(t => ({ id: t.id, data: session.tabMgr.scrollback(t.id) }))
            .filter(r => r.data && r.data.length);
        const activeId = (session.activeTab && tabList.some(t => t.id === session.activeTab))
            ? session.activeTab
            : (tabList[0] && tabList[0].id) || 0;
        ws.send(frame(MSG.HELLO, {
            serverVersion: 1,
            serverTime: Date.now(),
            tabs: tabList,
            activeId,
            replay,
        }));
    } catch (_) { /* ignore */ }

    ws.on('message', raw => {
        session.touch();
        const msg = parse(raw.toString());
        if (!msg) return;
        switch (msg.t) {
            case MSG.PING:
                try { ws.send(frame(MSG.PONG, { ts: Date.now() })); } catch (_) {}
                break;
            case MSG.REQUEST:
                if (msg.d && msg.d.what === 'snapshot') {
                    session.send(frame(MSG.SNAPSHOT, { tabs: session.tabMgr.list() }));
                }
                break;
            case MSG.INPUT:
                handleInput(session, msg.d || {});
                break;
            default: /* forward-compat: ignore unknown types */ break;
        }
    });

    ws.on('close', () => { session.detachSocket(ws); });
    ws.on('error', () => { /* close handler will fire too */ });
}

function handleInput(session, d) {
    const mgr = session.tabMgr;
    switch (d.kind) {
        case INPUT_KIND.NEW_TAB: {
            const t = mgr.open({ cols: d.cols, rows: d.rows });
            session.activeTab = t.id;
            session.send(frame(MSG.SNAPSHOT, { tabs: mgr.list(), activeId: t.id }));
            break;
        }
        case INPUT_KIND.SWITCH_TAB: {
            if (mgr.get(d.id)) session.activeTab = d.id;
            break;
        }
        case INPUT_KIND.CLOSE_TAB:
            mgr.close(d.id);
            break;
        case INPUT_KIND.MOVE_TAB:
            mgr.move(d.id, d.before);
            break;
        case INPUT_KIND.TERM_KEYS: {
            const tab = mgr.get(d.id);
            if (tab) tab.write(d.text || '');
            break;
        }
        case INPUT_KIND.TERM_RESIZE: {
            const tab = mgr.get(d.id);
            if (tab) tab.resize(Math.max(2, d.cols | 0), Math.max(2, d.rows | 0));
            break;
        }
        case INPUT_KIND.HOTKEY: {
            const tab = mgr.get(d.id);
            if (!tab) break;
            const combo = (d.combo || '').toLowerCase();
            const map = {
                'ctrl+c': '\x03', 'ctrl+d': '\x04', 'ctrl+z': '\x1a',
                'ctrl+l': '\x0c', 'ctrl+a': '\x01', 'ctrl+e': '\x05',
                'ctrl+k': '\x0b', 'ctrl+u': '\x15', 'ctrl+w': '\x17',
                'esc':    '\x1b',
                'up':     '\x1b[A', 'down': '\x1b[B', 'right': '\x1b[C', 'left': '\x1b[D',
            };
            if (map[combo]) tab.write(map[combo]);
            break;
        }
        case INPUT_KIND.SHELL_COMMAND: {
            const tab = mgr.get(d.id);
            if (tab && typeof d.line === 'string') tab.write(d.line + '\r');
            break;
        }
        default: /* ignore */ break;
    }
}

const heartbeat = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) { try { ws.terminate(); } catch (_) {} return; }
        ws.isAlive = false;
        try { ws.ping(); } catch (_) {}
    });
}, 5000);
if (heartbeat.unref) heartbeat.unref();

function shutdown(code = 0) {
    console.log('\nshutting down…');
    clearInterval(heartbeat);
    try { pair.stop(); } catch (_) {}
    try { wss.close(); } catch (_) {}
    try { sessions.shutdown(); } catch (_) {}
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 5000).unref();
}
process.on('SIGINT',  () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

server.listen(PORT, HOST, () => {
    console.log(`SoA-Web ready: http://${HOST}:${PORT}  (auth=${AUTH_MODE})`);
});

module.exports = { app, server };
