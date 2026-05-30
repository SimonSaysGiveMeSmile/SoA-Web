/**
 * SoA-Web server entry.
 *
 * HTTP serves the static browser bundle (web/public) + a tiny health API.
 * WebSocket at /ws owns the realtime channel: frames go through the shared
 * ./protocol.js schema, and every connected socket is bound to one Session
 * holding that browser's PTY pool.
 *
 * There is no login. Every visitor gets a fresh auto-provisioned session
 * (same cookie on return visits). Intended for local runtimes and personal
 * tunnels — anyone who can reach this URL can use the shell, by design.
 *
 * Configuration:
 *   SOA_WEB_HOST       bind host (default 127.0.0.1; set 0.0.0.0 for LAN/cloud)
 *   SOA_WEB_PORT       bind port (default 7332)
 *   SOA_WEB_SIGN_KEY   HMAC key for the session cookie (random per-process if unset)
 *   SOA_WEB_SHELL      shell binary; defaults to $SHELL or /bin/bash
 *   SOA_WEB_SESSION_TTL_MS  idle timeout for sessions (default 6h)
 *   SOA_WEB_DEV=1      dev mode — sends cache-control: no-store on static assets
 *   SOA_WEB_AUTOPAIR   '0' disables auto-starting the Cloudflare tunnel on boot
 *   SOA_WEB_SESSION_TOKEN  when set, every /api/* and /ws request must carry
 *                          ?t=<this-token> (or Authorization: Bearer <token>
 *                          on /api/*). Used by scripts/selfhost.js to gate a
 *                          tunneled backend so only the operator's browser can
 *                          reach it.
 */

const http = require('http');
const path = require('path');
const fs   = require('fs');

const WebSocket = require('ws');
const express   = require('express');

const consoleLogs      = require('./consoleLogs');

const { MSG, INPUT_KIND, frame, parse } = require('./protocol');
const { SessionStore } = require('./sessionStore');
const { TabManager }   = require('./tabManager');
const auth             = require('./auth');
const sysinfo          = require('./sysinfo');
const pairing          = require('./pairing');
const tabPersist       = require('./tabPersist');
const tabApi           = require('./tabApi');
const envStore         = require('./envStore');
const autoCompact      = require('./autoCompact');
const autoPilot        = require('./autoPilot');
const { dbg, agg }     = require('./debug');

const HOST = process.env.SOA_WEB_HOST || '0.0.0.0';
const PORT = parseInt(process.env.SOA_WEB_PORT || '7332', 10);
let activePort = PORT;
const DEV  = process.env.SOA_WEB_DEV === '1';
const SESSION_TTL_MS = parseInt(process.env.SOA_WEB_SESSION_TTL_MS || String(1000 * 60 * 60 * 6), 10);

const SIGN_KEY   = auth.resolveSignKey();
const SECURE_COOKIE = process.env.SOA_WEB_SECURE_COOKIE === '1';
const SESSION_TOKEN = process.env.SOA_WEB_SESSION_TOKEN || '';

function constantTimeEq(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    try {
        return require('crypto').timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch (_) { return false; }
}

function extractPresentedToken(req) {
    const url = new URL(req.url || '/', 'http://localhost');
    const fromQuery = url.searchParams.get('t');
    if (fromQuery) return fromQuery;
    const authz = req.headers && req.headers.authorization;
    if (authz && /^bearer /i.test(authz)) return authz.slice(7).trim();
    return '';
}

// When the static SPA is served from a different origin (e.g. Vercel) and
// this backend sits behind a Cloudflare Quick Tunnel, the browser needs CORS
// on /api/* and a SameSite=None cookie. A default allowlist covers the
// common case: the deployed frontend at www.s0a.app auto-upgrading to a
// freshly installed 127.0.0.1:4010 backend. Extend via SOA_WEB_ALLOWED_ORIGINS.
const DEFAULT_ALLOWED_ORIGINS = [
    'https://www.s0a.app',
    'https://s0a.app',
    'http://localhost:' + PORT,
    'http://127.0.0.1:' + PORT,
    ...pairing.lanAddresses(PORT, 'http'),
];
const ALLOWED_ORIGINS = Array.from(new Set([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...(process.env.SOA_WEB_ALLOWED_ORIGINS || '')
        .split(',').map(s => s.trim()).filter(Boolean),
]));
const CROSS_SITE = ALLOWED_ORIGINS.some(o => !/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(o));

const sessions = new SessionStore({ idleTtlMs: SESSION_TTL_MS });

// Boot-time restore: re-seat the previously persisted session under its
// original token so any browser cookie still in the wild keeps working
// after a server restart. Tab cwds and scrollback are restored lazily on
// the first WS connect (see onWsConnect) so we don't spawn PTYs for a
// session no one is actually visiting.
const _persistedSession = tabPersist.loadSession();
if (_persistedSession) {
    try { sessions.create({ id: _persistedSession.id, token: _persistedSession.token }); }
    catch (_) { /* corrupted state — fall through, fresh session minted on first hit */ }
}

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

// CORS: only reply with the exact Origin header if it's in the allowlist. No
// wildcard because the browser refuses credentialed requests with `*`.
//
// Private Network Access: Chrome blocks public→private fetches unless the
// preflight also confirms `Access-Control-Allow-Private-Network: true`. We
// echo the request header on allowed preflights; without this, the deployed
// SPA can't auto-detect a freshly installed localhost backend.
app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowed = origin && ALLOWED_ORIGINS.includes(origin);
    if (allowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'content-type');
        res.setHeader('Access-Control-Max-Age', '600');
        if (req.headers['access-control-request-private-network'] === 'true') {
            res.setHeader('Access-Control-Allow-Private-Network', 'true');
        }
    }
    if (req.method === 'OPTIONS' && origin) {
        return res.status(allowed ? 204 : 403).end();
    }
    next();
});

// Optional session token gate. When SOA_WEB_SESSION_TOKEN is set, every
// /api/* call (except the /api/ping discovery endpoint) must present the
// token via ?t= or Authorization: Bearer. /api/ping stays open so the
// client can probe for a reachable backend without yet knowing the token.
app.use((req, res, next) => {
    if (!SESSION_TOKEN) return next();
    if (!req.path.startsWith('/api/')) return next();
    if (req.path === '/api/ping') return next();
    const presented = extractPresentedToken(req);
    if (!constantTimeEq(presented, SESSION_TOKEN)) {
        return res.status(401).json({ ok: false, error: 'invalid session token' });
    }
    next();
});

const PUBLIC_DIR = path.resolve(__dirname, '../../web/public');
// Single source of truth for the mobile companion lives under web/public/m
// so that both this Node backend and the Vercel static deploy serve the same
// client. (mobile/dist/ used to be a separate copy and drifted out of sync.)
const MOBILE_DIR = path.resolve(__dirname, '../../web/public/m');
const CONFIG_SNIPPET = `window.__SOA_WEB__ = ${JSON.stringify({ protocol: 1, backend: '' })};`;

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

// Auto-provisions a session so the browser has a stable identity. No login —
// every visitor gets a fresh session on first contact, then the signed cookie
// keeps them on the same one across reloads.
function requireAuthed(req, res, next) {
    let s = currentSession(req);
    if (!s) {
        s = sessions.create();
        const token = auth.issue(s.token, SIGN_KEY);
        res.setHeader('Set-Cookie', auth.makeCookie(token, { secure: SECURE_COOKIE, crossSite: CROSS_SITE }));
        tabPersist.saveSession({ id: s.id, token: s.token });
    }
    req.session = s;
    s.touch();
    next();
}

// ── API ─────────────────────────────────────────────────────────────────
app.get('/api/ping', (req, res) => {
    res.json({ ok: true, name: 'soa-web', protocol: 1, tokenRequired: !!SESSION_TOKEN });
});

app.get('/api/me', requireAuthed, (req, res) => {
    res.json({ ok: true, authed: true });
});

app.get('/api/devices', requireAuthed, (req, res) => {
    const s = req.session;
    const devices = [];
    for (const ws of s.sockets) {
        if (!ws || ws.readyState !== 1) continue;
        devices.push({
            connectedAt: ws._connectedAt || null,
            userAgent: ws._userAgent || '',
        });
    }
    res.json({ ok: true, count: devices.length, devices });
});

// ── Sidebar + mobile-pairing routes ─────────────────────────────────────
consoleLogs.mount(app, requireAuthed);
sysinfo.mount(app, requireAuthed);
const pair = new pairing.PairingManager({ port: PORT });
pairing.mount(app, requireAuthed, pair, {
    onTunnelUp: (url) => {
        if (!ALLOWED_ORIGINS.includes(url)) ALLOWED_ORIGINS.push(url);
    },
});
tabApi.mount(app, requireAuthed, sessions);
envStore.mount(app, requireAuthed);
autoCompact.mount(app, requireAuthed);
autoPilot.mount(app, requireAuthed);

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

// install.sh hit logger. One JSON line per fetch — most reliable conversion
// signal we have, since this is the command on the welcome gate. Writes to
// SOA_WEB_INSTALL_LOG (default ~/.soa-web/install-log.jsonl). Best-effort:
// any I/O error is swallowed so a broken disk can't take the page down.
const INSTALL_LOG_PATH = process.env.SOA_WEB_INSTALL_LOG
    || path.join(require('os').homedir(), '.soa-web', 'install-log.jsonl');
function logInstallHit(req) {
    try {
        const dir = path.dirname(INSTALL_LOG_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const url = new URL(req.url || '/install.sh', 'http://localhost');
        const entry = {
            ts: new Date().toISOString(),
            ip: (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim(),
            country: req.headers['cf-ipcountry'] || '',
            ua: (req.headers['user-agent'] || '').slice(0, 200),
            ref: url.searchParams.get('ref') || (req.headers['referer'] || ''),
        };
        fs.appendFile(INSTALL_LOG_PATH, JSON.stringify(entry) + '\n', () => {});
    } catch (_) { /* best-effort */ }
}
app.get('/install.sh', (req, res, next) => {
    res.set('cache-control', 'no-store');
    logInstallHit(req);
    next();
});

app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'] }));

// Mobile companion PWA served at /m/
app.use('/m', express.static(MOBILE_DIR, { index: 'index.html', extensions: ['html'] }));
app.get('/m/*', (req, res) => {
    res.sendFile(path.join(MOBILE_DIR, 'index.html'));
});

// SPA fallback — any unknown GET serves index.html so client-side routes work.
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/_') || req.path.startsWith('/m')) return next();
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ── HTTP + WS server ────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const ua = (req.headers['user-agent'] || '').slice(0, 80);
    const origin = req.headers.origin || '(none)';
    dbg('ws-upgrade', 'incoming', url.pathname, 'origin=' + origin, 'hasCookie=' + !!req.headers.cookie, 'hasToken=' + !!url.searchParams.get('t'), 'ua=' + ua);
    if (url.pathname !== '/ws') { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }

    if (SESSION_TOKEN) {
        const presented = url.searchParams.get('t') || '';
        if (!constantTimeEq(presented, SESSION_TOKEN)) {
            dbg('ws-upgrade', 'REJECT 401: session token mismatch (presented len=' + presented.length + ')');
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
    }

    // When the allowlist is configured, enforce it on WS upgrades too so a
    // random page can't open an authenticated shell against this backend.
    // Skip this check when a valid SESSION_TOKEN was presented — the token
    // already proves authorization (covers mobile via tunnel URLs that
    // aren't in the static allowlist).
    const tokenValid = SESSION_TOKEN && constantTimeEq(url.searchParams.get('t') || '', SESSION_TOKEN);
    if (CROSS_SITE && !tokenValid) {
        const origin = req.headers.origin;
        const sameOrigin = !origin; // curl / non-browser clients
        if (!sameOrigin && !ALLOWED_ORIGINS.includes(origin)) {
            dbg('ws-upgrade', 'REJECT 403: origin not in allowlist:', origin, '— allowed:', ALLOWED_ORIGINS.join(','));
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
        }
    }

    const existing = ((req) => {
        const raw = auth.readCookie(req.headers.cookie || '', auth.COOKIE_NAME);
        if (!raw) return null;
        const decoded = auth.verify(raw, SIGN_KEY);
        if (!decoded) return null;
        try {
            const payload = JSON.parse(Buffer.from(decoded, 'base64url').toString('utf8'));
            return sessions.getByToken(payload.sub);
        } catch (_) { return null; }
    })(req);

    // When a client (e.g. mobile) arrives with a valid SESSION_TOKEN but no
    // cookie, share the primary desktop session instead of minting an empty one.
    // This lets the mobile companion see the same tabs and terminal output.
    let session = existing || _findPrimarySession();
    if (!session) {
        session = sessions.create();
        tabPersist.saveSession({ id: session.id, token: session.token });
        dbg('ws-upgrade', 'bound to NEW empty session', session.id.slice(0, 8), '(no cookie match, no primary found — mobile will see no tabs)');
    } else {
        const via = existing ? 'cookie' : 'primary-share';
        const tabCount = session.tabMgr ? session.tabMgr.order.length : 0;
        dbg('ws-upgrade', 'bound to session', session.id.slice(0, 8), 'via', via, '— tabs=' + tabCount, 'existingSockets=' + session.sockets.size);
    }
    wss.handleUpgrade(req, socket, head, ws => onWsConnect(ws, session, req));
});

function _findPrimarySession() {
    for (const s of sessions.sessions.values()) {
        if (s.tabMgr && s.tabMgr.order.length > 0) return s;
    }
    return null;
}

// Canonical activeId — the SNAPSHOT broadcasts used to send `activeTab || 0`
// while HELLO had a tabList fallback. The mismatch let cwd-poll-triggered
// snapshots overwrite the mobile client's activeTabId to 0, after which
// TERM_DATA frames carrying the real tab id were buffered forever and never
// flushed (T counter rises, screen stays blank). Use this helper everywhere
// activeId is emitted so all frames agree.
function _canonicalActiveId(session, tabList) {
    const list = tabList || (session.tabMgr ? session.tabMgr.list() : []);
    if (session.activeTab && list.some(t => t.id === session.activeTab)) {
        return session.activeTab;
    }
    return (list[0] && list[0].id) || 0;
}

function _broadcastDeviceCount(session, excludeWs) {
    const count = session.sockets.size;
    const tabList = session.tabMgr ? session.tabMgr.list() : [];
    const payload = frame(MSG.SNAPSHOT, {
        tabs: tabList,
        activeId: _canonicalActiveId(session, tabList),
        graveyard: session.tabMgr ? session.tabMgr.graveyardList() : [],
        connectedDevices: count,
    });
    for (const ws of session.sockets) {
        if (ws === excludeWs) continue;
        if (!ws || ws.readyState !== 1) continue;
        try { ws.send(payload); } catch (_) {}
    }
}

function onWsConnect(ws, session, req) {
    ws._connectedAt = Date.now();
    ws._userAgent = (req && req.headers && req.headers['user-agent']) || '';
    session.attachSocket(ws);
    session.touch();
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    if (!session.tabs) session.tabs = [];
    if (!session.tabMgr) {
        session.tabMgr = new TabManager({
            onData: (tabId, data) => {
                agg('term-out', 'session=' + session.id.slice(0, 8) + ' tab=' + tabId, data.length, '→ ' + session.sockets.size + ' socket(s)');
                session.send(frame(MSG.TERM_DATA, { id: tabId, data }));
            },
            onTabsChange: list => {
                // If the active tab just went away, pick the next available
                // one so HELLO after a reload doesn't point at a dead id.
                if (session.activeTab && !list.some(t => t.id === session.activeTab)) {
                    session.activeTab = (list[0] && list[0].id) || 0;
                }
                session.send(frame(MSG.SNAPSHOT, {
                    tabs: list,
                    activeId: _canonicalActiveId(session, list),
                    graveyard: session.tabMgr.graveyardList(),
                    connectedDevices: session.sockets.size,
                }));
                tabPersist.save(session.tabMgr);
            },
            onExit: (tabId, code) => session.send(frame(MSG.TERM_EXIT, { id: tabId, code })),
        });

        // Periodic cwd poll: catches directory changes from running programs
        // (scripts, subshells) that don't trigger the Enter-key poll path.
        session._cwdInterval = setInterval(() => {
            for (const id of session.tabMgr.order) {
                session.tabMgr.pokeCwd(id);
            }
        }, 3000);
        if (session._cwdInterval.unref) session._cwdInterval.unref();

        // Restore tabs from disk if this is a fresh session with no tabs.
        // Seed each new shell's scrollback with the bytes saved by the prior
        // run so the user sees the conversation/work that was on screen
        // before the restart. The PTY itself is fresh — divider makes that
        // explicit so nobody mistakes the seeded text for a live process.
        // Match scrollback to tab by index; cwd doubles as a sanity check so
        // a desync between the two files doesn't cross-paste history.
        const saved = tabPersist.load();
        if (saved && saved.tabs.length > 0 && session.tabMgr.order.length === 0) {
            const shellEnv = envStore.getEnvForShell();
            const savedSb = tabPersist.loadScrollback();
            const sbList = (savedSb && Array.isArray(savedSb.tabs)) ? savedSb.tabs : [];
            saved.tabs.forEach((entry, i) => {
                const cwd = entry.cwd && fs.existsSync(entry.cwd) ? entry.cwd : undefined;
                const sb = sbList[i];
                const prior = (sb && sb.cwd === entry.cwd && typeof sb.scrollback === 'string') ? sb.scrollback : '';
                const label = entry.userRenamed && entry.title ? entry.title : (cwd || 'tab');
                const seed = prior
                    ? prior + `\r\n\x1b[2m── ${label} · context restored from previous session (fresh shell) ──\x1b[0m\r\n`
                    : '';
                session.tabMgr.open({
                    title: entry.userRenamed ? entry.title : undefined,
                    cwd,
                    env: shellEnv,
                    silent: true,
                    seedScrollback: seed || undefined,
                });
            });
        }

        autoPilot.instance.attach(session.tabMgr, (tabId) => session._agentStatus && session._agentStatus.get(tabId) || 'idle');
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
        const activeId = _canonicalActiveId(session, tabList);
        // Persist back so later snapshot broadcasts stay consistent — without
        // this, a session attached for the first time has activeTab=undefined
        // and the next cwd-poll snapshot would re-broadcast activeId:0.
        session.activeTab = activeId;
        ws.send(frame(MSG.HELLO, {
            serverVersion: 1,
            serverTime: Date.now(),
            tabs: tabList,
            activeId,
            replay,
            graveyard: session.tabMgr.graveyardList(),
            connectedDevices: session.sockets.size,
        }));
        dbg('ws-hello', 'sent to', ws._userAgent.slice(0, 40), '— tabs=' + tabList.length, 'activeId=' + activeId, 'replayBytes=' + replay.reduce((n, r) => n + r.data.length, 0), 'devices=' + session.sockets.size);
        // Notify other clients that a new device joined
        _broadcastDeviceCount(session, ws);
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
                    session.send(frame(MSG.SNAPSHOT, {
                        tabs: session.tabMgr.list(),
                        activeId: _canonicalActiveId(session),
                        graveyard: session.tabMgr.graveyardList(),
                        connectedDevices: session.sockets.size,
                    }));
                }
                break;
            case MSG.INPUT:
                handleInput(session, msg.d || {});
                break;
            default: /* forward-compat: ignore unknown types */ break;
        }
    });

    ws.on('close', () => {
        session.detachSocket(ws);
        _broadcastDeviceCount(session);
    });
    ws.on('error', () => { /* close handler will fire too */ });
}

function handleInput(session, d) {
    const mgr = session.tabMgr;
    if (d.kind === INPUT_KIND.TERM_RESIZE) {
        dbg('input', 'TERM_RESIZE from device — tab=' + d.id, d.cols + 'x' + d.rows, '(resizes SHARED pty; desktop will reflow)');
    } else if (d.kind === INPUT_KIND.TERM_KEYS) {
        dbg('input', 'TERM_KEYS tab=' + d.id, JSON.stringify((d.text || '').slice(0, 16)));
    } else if (d.kind) {
        dbg('input', d.kind, 'tab=' + (d.id != null ? d.id : '-'));
    }
    // Debounce cwd polling per tab: a typed `cd /foo && cd /bar` bursts
    // several CRs within a few ms, and we only want one lsof/readlink per
    // burst. The timer is stored on the session so it's GC'd with it.
    const schedulePokeCwd = (id) => {
        const poll = session._cwdPoll || (session._cwdPoll = new Map());
        clearTimeout(poll.get(id));
        poll.set(id, setTimeout(() => {
            poll.delete(id);
            mgr.pokeCwd(id);
        }, 120));
    };
    switch (d.kind) {
        case INPUT_KIND.NEW_TAB: {
            const cwd = (typeof d.cwd === 'string' && d.cwd && fs.existsSync(d.cwd)) ? d.cwd : undefined;
            const t = mgr.open({ cols: d.cols, rows: d.rows, cwd, silent: true, env: envStore.getEnvForShell() });
            session.activeTab = t.id;
            session.send(frame(MSG.SNAPSHOT, { tabs: mgr.list(), activeId: t.id, connectedDevices: session.sockets.size }));
            break;
        }
        case INPUT_KIND.SWITCH_TAB: {
            if (mgr.get(d.id) && session.activeTab !== d.id) {
                session.activeTab = d.id;
                session.send(frame(MSG.SNAPSHOT, { tabs: mgr.list(), activeId: d.id, connectedDevices: session.sockets.size }));
            }
            break;
        }
        case INPUT_KIND.CLOSE_TAB:
            mgr.close(d.id);
            break;
        case INPUT_KIND.MOVE_TAB:
            mgr.move(d.id, d.before);
            break;
        case INPUT_KIND.RENAME_TAB: {
            const title = typeof d.title === 'string' ? d.title.slice(0, 64) : '';
            mgr.rename(d.id, title);
            break;
        }
        case INPUT_KIND.SET_TITLE: {
            // OSC 0/2 title sequences from programs (zsh prompt, Claude Code
            // status line, etc.) are intentionally ignored for tab naming.
            // Tab names follow the cwd folder name exclusively, unless the
            // user manually renames. This prevents noisy programs from
            // constantly overriding the clean folder-based label.
            break;
        }
        case INPUT_KIND.RESTORE_TAB: {
            // Pop the chosen entry (or the most-recent one) from the graveyard
            // and spawn a fresh shell at its saved cwd. The new tab's scrollback
            // is pre-seeded with the archived bytes + a divider — the client
            // will receive those bytes as normal TERM_DATA from onData once it
            // switches in, via the next HELLO/reconnect, or via the new-tab
            // SNAPSHOT below. Replay the seed now to the live socket so the
            // user sees the context without needing a reload.
            const t = mgr.restore({ id: d.id != null ? +d.id : null, cols: d.cols, rows: d.rows });
            if (t) {
                session.activeTab = t.id;
                session.send(frame(MSG.TERM_DATA, { id: t.id, data: mgr.scrollback(t.id) }));
                session.send(frame(MSG.SNAPSHOT, {
                    tabs: mgr.list(),
                    activeId: t.id,
                    graveyard: mgr.graveyardList(),
                    connectedDevices: session.sockets.size,
                }));
            }
            break;
        }
        case INPUT_KIND.TERM_KEYS: {
            const tab = mgr.get(d.id);
            if (tab) {
                const text = d.text || '';
                tab.write(text);
                // Enter (CR/LF) is the only keystroke that plausibly ends
                // a `cd` command — poll the shell's cwd on a short delay
                // so node-pty has time to flush and the shell has time to
                // chdir. Throttled per-tab to keep lsof off the hot path.
                if (/[\r\n]/.test(text)) schedulePokeCwd(d.id);
            }
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
        case INPUT_KIND.CTX_REPORT: {
            const pct = Number(d.pct);
            if (Number.isFinite(pct) && d.id) {
                autoCompact.reportCtx(mgr, d.id, pct);
            }
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

// Persist scrollback to disk every 5 minutes so a server restart doesn't
// lose the on-screen context. Metadata (titles, cwds) is already saved on
// every change; this captures the live PTY output for each tab.
const SCROLLBACK_FLUSH_MS = parseInt(process.env.SOA_WEB_SCROLLBACK_FLUSH_MS || String(5 * 60 * 1000), 10);
const scrollbackFlush = setInterval(() => {
    for (const s of sessions.sessions.values()) {
        if (s.tabMgr) tabPersist.saveAll(s.tabMgr);
    }
}, SCROLLBACK_FLUSH_MS);
if (scrollbackFlush.unref) scrollbackFlush.unref();

function shutdown(code = 0) {
    console.log('\nshutting down…');
    clearInterval(heartbeat);
    clearInterval(scrollbackFlush);
    // Persist tabs + scrollback before killing PTYs so the next boot can
    // seed each tab with what was on screen.
    for (const s of sessions.sessions.values()) {
        if (s.tabMgr) tabPersist.saveAll(s.tabMgr);
    }
    try { pair.stop(); } catch (_) {}
    try { wss.close(); } catch (_) {}
    try { sessions.shutdown(); } catch (_) {}
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 5000).unref();
}
process.on('SIGINT',  () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function onListening() {
    activePort = server.address().port;
    sysinfo.setSoaPort(activePort);
    console.log(`SoA-Web ready: http://${HOST}:${activePort}`);

    if (process.env.SOA_WEB_AUTOPAIR !== '0') {
        pair.start().then(snap => {
            if (snap.state === 'online' && snap.publicUrl) {
                if (!ALLOWED_ORIGINS.includes(snap.publicUrl)) {
                    ALLOWED_ORIGINS.push(snap.publicUrl);
                }
                console.log(`SoA-Web tunnel:  ${snap.publicUrl}  (QR in the sidebar)`);
            } else if (snap.state === 'error') {
                console.log(`SoA-Web tunnel:  unavailable — ${snap.error}`);
            }
        }).catch(() => {});
    }
}

function tryListen(port) {
    server.listen(port, HOST);
}

server.on('listening', onListening);
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        const next = (activePort === PORT ? PORT : activePort) + 1;
        if (next > PORT + 20) {
            console.error(`SoA-Web: ports ${PORT}–${next - 1} all occupied, giving up.`);
            process.exit(1);
        }
        console.log(`SoA-Web: port ${err.port || activePort} in use, trying ${next}…`);
        activePort = next;
        tryListen(next);
    } else {
        console.error('SoA-Web server error:', err);
        process.exit(1);
    }
});

tryListen(PORT);

module.exports = { app, server };
