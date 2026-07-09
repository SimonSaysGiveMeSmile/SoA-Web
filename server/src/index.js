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
const claudeUsage      = require('./claudeUsage');
const pairing          = require('./pairing');
const tabPersist       = require('./tabPersist');
const procMem          = require('./procMem');
const claudeSessions   = require('./claudeSessions');
const tabApi           = require('./tabApi');
const envStore         = require('./envStore');
const autoCompact      = require('./autoCompact');
const autoPilot        = require('./autoPilot');
const preview          = require('./preview');
const pasteImage       = require('./pasteImage');
const tts              = require('./tts');
const agentBrowser     = require('./agentBrowser');
const windowControl    = require('./windowControl');
const sessionManager   = require('./sessionManager');
const userProfile      = require('./userProfile');
const { dbg, agg }     = require('./debug');
const { STATE_DIR, MODE } = require('./stateDir');
const instanceLock     = require('./instanceLock');

const HOST = process.env.SOA_WEB_HOST || '0.0.0.0';
const PORT = parseInt(process.env.SOA_WEB_PORT || '7332', 10);
let activePort = PORT;

// One daemon per state dir — a second instance pointed at the same dir would
// clobber tabs.json/scrollback.json (the 2026-06 corruption incidents). Must
// run before any state is read or written; exits with a clear message if the
// dir is owned by a live daemon.
instanceLock.acquireOrExit(PORT);
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
    // Native app shells (Capacitor). The iOS/Android "Son of Anton" app serves
    // its bundled web client from a local scheme, so its WS/CORS Origin is a
    // fixed capacitor:// (iOS) / http://localhost (Android) — not the backend's
    // own origin. Trust them so the native app's /ws upgrade isn't 403'd.
    'capacitor://localhost',
    'ionic://localhost',
    'http://localhost',
    ...pairing.lanAddresses(PORT, 'http'),
];
const ALLOWED_ORIGINS = Array.from(new Set([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...(process.env.SOA_WEB_ALLOWED_ORIGINS || '')
        .split(',').map(s => s.trim()).filter(Boolean),
]));
const CROSS_SITE = ALLOWED_ORIGINS.some(o => !/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(o));

const sessions = new SessionStore({ idleTtlMs: SESSION_TTL_MS });

// Self-heal a clobbered fleet BEFORE anything reads tabs.json: if the tab list
// was lost (empty/missing, and not an intentional close-all) but scrollback.json
// still holds the per-tab cwds, rebuild tabs.json from it. restore-on-connect +
// auto-resume below then rehydrate the fleet automatically — no manual
// soa-relaunch. No-op when tabs are intact or the user cleared them.
try {
    const _rec = tabPersist.reconcileTabsFromScrollback();
    if (_rec.action === 'recovered') {
        console.log(`tabPersist: RECOVERED ${_rec.count} tab(s) from scrollback.json — tabs.json was lost (clobber self-heal)`);
    } else if (_rec.action === 'error') {
        console.log('tabPersist: fleet reconcile failed:', _rec.reason);
    }
} catch (_) { /* best-effort — never block boot on recovery */ }

// Boot-time restore: re-seat the previously persisted session under its
// original token so any browser cookie still in the wild keeps working
// after a server restart. Tab cwds and scrollback are restored lazily on
// the first WS connect (see onWsConnect) so we don't spawn PTYs for a
// session no one is actually visiting.
const _persistedSession = tabPersist.loadSession();
// Truth flag for "the saved fleet was actually rehydrated somewhere this
// process". Boot-resume keys off THIS — not off "some session has tabs",
// which a client's own fresh tab used to satisfy, cancelling rehydration.
let _diskRestoreRan = false;
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
        // Echo the preflight's requested headers (credentialed CORS can't use '*')
        // so custom headers the SPA adds — e.g. `ngrok-skip-browser-warning` on the
        // backend probe — pass preflight instead of being rejected (which dropped the
        // deployed s0a.app into sandbox mode). Falls back to the known set off-preflight.
        res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'content-type, ngrok-skip-browser-warning');
        res.setHeader('Access-Control-Max-Age', '600');
        // Send on every allowed response (not just preflight) — Chrome requires
        // the PNA header on the actual response too, not only on OPTIONS.
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
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
    // Loopback-trusted endpoints (/api/sessions, /api/tts) carry their OWN
    // tunnel-aware local-only gate and are driven by local CLIs (soa-sessions /
    // soa-msg) that don't know the session token. Exempt them ONLY for genuinely
    // local callers — a tunneled request still fails the endpoint's loopback gate.
    // Without this, token mode (selfhost) would 401 the manager + the TTS hook.
    if ((req.path === '/api/sessions' || req.path === '/api/tts') && sessionManager.isLocalRequest(req)) return next();
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

// Approximate location of every connected client, for the WorldView globe's
// multiuser pins. One entry per DISTINCT public IP (city-level, from ipinfo) —
// LAN/localhost clients collapse into a single "local" cluster at the server's
// own egress location. Raw IPs are never returned: only lat/lon/city/country +
// a device count, so a peer can be pinned without being identified.
app.get('/api/geo/peers', requireAuthed, async (req, res) => {
    const byIp = new Map();   // public IP -> live-socket count
    let localCount = 0;       // LAN/localhost sockets (server's own location)
    for (const s of sessions.sessions.values()) {
        for (const ws of s.sockets) {
            if (!ws || ws.readyState !== 1) continue;
            const ip = ws._remoteIp || '';
            if (!ip || sysinfo.isPrivateIp(ip)) { localCount++; continue; }
            byIp.set(ip, (byIp.get(ip) || 0) + 1);
        }
    }
    const peers = [];
    if (localCount > 0) {
        try {
            const g = await sysinfo.geoInfo();
            if (g && g.lat != null) {
                peers.push({ lat: g.lat, lon: g.lon, city: g.city, region: g.region, country: g.country, count: localCount, self: true });
            }
        } catch (_) { /* server geo unavailable — skip the local cluster */ }
    }
    // Cap the distinct-IP fan-out so a flood of connections can't spray the
    // upstream; per-IP results are cached 6h so this is cheap in steady state.
    const ips = [...byIp.keys()].slice(0, 64);
    const geos = await Promise.all(ips.map(ip => sysinfo.geoForIp(ip).catch(() => null)));
    geos.forEach((g, i) => {
        if (g && g.lat != null) {
            peers.push({ lat: g.lat, lon: g.lon, city: g.city, region: g.region, country: g.country, count: byIp.get(ips[i]) });
        }
    });
    const total = peers.reduce((n, p) => n + (p.count || 1), 0);
    res.json({ ok: true, data: { peers, total, locatable: peers.length } });
});

// Aggregate per-user stats for the profile panel. /api/devices only ever sees
// the CALLER's own session sockets (and a browser's WS may bind to the primary
// session, not its cookie session — so that endpoint reads 0 for an API caller).
// This one reports the GLOBAL live client count, a fleet token estimate (sum of
// each tab's context% × the context window), and the egress country for a flag.
// Cheap enough to be polled by the open profile pane for a live readout.
app.get('/api/user/stats', requireAuthed, async (req, res) => {
    let connectedClients = 0;
    for (const s of sessions.sessions.values()) {
        for (const ws of s.sockets) {
            if (ws && ws.readyState === 1) connectedClients++;
        }
    }
    const CONTEXT_WINDOW = parseInt(process.env.SOA_WEB_CONTEXT_WINDOW || '200000', 10);
    let estTokens = 0, activeTabs = 0, ctxSum = 0, ctxTabs = 0;
    try {
        const primary = _findPrimarySession() || req.session;
        if (primary) {
            const snap = sessionManager.ensure(primary).snapshot();
            activeTabs = snap.sessions.length;
            for (const t of snap.sessions) {
                if (typeof t.ctxPct === 'number') {
                    estTokens += Math.round((t.ctxPct / 100) * CONTEXT_WINDOW);
                    ctxSum += t.ctxPct; ctxTabs++;
                }
            }
        }
    } catch (_) { /* supervisor not ready — return zeros */ }
    let country = null, city = null;
    try {
        const g = await sysinfo.geoInfo();
        if (g) { country = g.country || null; city = g.city || null; }
    } catch (_) { /* geo unavailable — flag falls back client-side */ }
    res.json({
        ok: true,
        connectedClients,
        estTokens,
        activeTabs,
        avgCtxPct: ctxTabs ? Math.round(ctxSum / ctxTabs) : 0,
        contextWindow: CONTEXT_WINDOW,
        country,
        city,
    });
});

// ── Sidebar + mobile-pairing routes ─────────────────────────────────────
consoleLogs.mount(app, requireAuthed);
sysinfo.mount(app, requireAuthed);
claudeUsage.mount(app, requireAuthed);
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
preview.mount(app, requireAuthed);
pasteImage.mount(app, requireAuthed);
tts.mount(app, sessions);
agentBrowser.mount(app, requireAuthed, sessions);
sessionManager.mount(app, requireAuthed, sessions);
userProfile.mount(app, requireAuthed);

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
    || require('./stateDir').stateFile('install-log.jsonl');
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
    // Dev-server HMR websockets for the local-web preview proxy.
    if (url.pathname.startsWith('/preview/') && preview.proxyUpgrade(req, socket, head)) return;
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

    // Share the primary desktop session (the one with live tabs) whenever this
    // connection doesn't already own a non-empty session. Mobile reliably picks
    // up its OWN empty cookie-session from authed /api/* polls (sysinfo, etc.);
    // if we honored that cookie it would bind to an empty session and show a
    // dead/stale terminal while the desktop streams to the primary — the exact
    // "different state on each device" divergence. Only an existing session that
    // already has tabs of its own is trusted over the primary.
    const existingHasTabs = existing && existing.tabMgr && existing.tabMgr.order.length > 0;
    let session = existing;
    let via = 'cookie';
    if (!existingHasTabs) {
        const primary = _findPrimarySession();
        if (primary && primary !== existing) {
            if (existing) dbg('ws-upgrade', 'cookie session', existing.id.slice(0, 8), 'is empty — sharing primary', primary.id.slice(0, 8));
            session = primary;
            via = existing ? 'primary-over-empty-cookie' : 'primary-share';
        }
    }
    if (!session) {
        session = sessions.create();
        tabPersist.saveSession({ id: session.id, token: session.token });
        dbg('ws-upgrade', 'bound to NEW empty session', session.id.slice(0, 8), '(no cookie match, no primary found — mobile will see no tabs)');
    } else {
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

function _broadcastDeviceCount(session, excludeWs) {
    const count = session.sockets.size;
    const payload = frame(MSG.SNAPSHOT, {
        tabs: session.tabMgr ? session.tabMgr.list() : [],
        activeId: session.activeTab || 0,
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
    // Real client IP for the WorldView peer map. Behind cloudflared the visitor
    // IP arrives as CF-Connecting-IP; LAN/localhost clients keep their private
    // address (geolocated to the server's egress in /api/geo/peers).
    const _h = (req && req.headers) || {};
    ws._remoteIp = (_h['cf-connecting-ip'] || (_h['x-forwarded-for'] || '').split(',')[0]
        || (req && req.socket && req.socket.remoteAddress) || '').toString().trim();
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
                // Feed the always-on supervisor so it tracks status + context
                // for every tab regardless of which client is watching.
                try { sessionManager.ensure(session).feed(tabId, data); } catch (_) {}
            },
            onTabsChange: list => {
                // If the active tab just went away, pick the next available
                // one so HELLO after a reload doesn't point at a dead id.
                if (session.activeTab && !list.some(t => t.id === session.activeTab)) {
                    session.activeTab = (list[0] && list[0].id) || 0;
                }
                session.send(frame(MSG.SNAPSHOT, {
                    tabs: list,
                    activeId: session.activeTab || 0,
                    graveyard: session.tabMgr.graveyardList(),
                    connectedDevices: session.sockets.size,
                }));
                tabPersist.save(session.tabMgr);
            },
            onExit: (tabId, code) => {
                try { agentBrowser.teardown(tabId); } catch (_) {}
                // Emit a clean 'exited' manager event + forget stale tab state
                // (status, stuck latch). forget() was never called before — a
                // latent leak the event/stuck machinery would otherwise inherit.
                try { sessionManager.ensure(session).noteExit(tabId); } catch (_) {}
                session.send(frame(MSG.TERM_EXIT, { id: tabId, code }));
            },
        });

        // Periodic cwd poll: catches directory changes from running programs
        // (scripts, subshells) that don't trigger the Enter-key poll path.
        session._cwdInterval = setInterval(() => {
            for (const id of session.tabMgr.order) {
                session.tabMgr.pokeCwd(id);
            }
        }, 3000);
        if (session._cwdInterval.unref) session._cwdInterval.unref();

        // Supervisor tick: refresh stuck/idle derivations and push a MANAGER
        // snapshot to the dashboard. Always-on (independent of connected clients).
        session._managerInterval = setInterval(() => {
            try {
                const m = sessionManager.ensure(session);
                m.emitStuckSweep();   // time-derived 'stuck' → manager event
                m.broadcast();
            } catch (_) {}
        }, 3000);
        if (session._managerInterval.unref) session._managerInterval.unref();

        // Restore tabs from disk into a fresh session. Seed each new shell's
        // scrollback with the bytes saved by the prior run so the user sees
        // the conversation/work that was on screen before the restart. The
        // PTY itself is fresh — divider makes that explicit so nobody
        // mistakes the seeded text for a live process. Match scrollback to
        // tab by index; cwd doubles as a sanity check so a desync between the
        // two files doesn't cross-paste history.
        //
        // Runs even when the session already holds tab(s): the old
        // "order.length === 0" gate meant any client that got a tab in first
        // (a mobile view binding right at boot) cancelled rehydration
        // entirely and its tiny list then persisted over the saved fleet —
        // the 2026-07-08 fleet loss. Saved entries already represented live
        // (same cwd, multiset) are skipped, and the per-session latch stops
        // a second pass, so nothing double-opens.
        const saved = tabPersist.load();
        if (saved && Array.isArray(saved.tabs) && saved.tabs.length > 0 && !session._diskRestored) {
            session._diskRestored = true;
            _diskRestoreRan = true;
            const shellEnv = envStore.getEnvForShell();
            const savedSb = tabPersist.loadScrollback();
            const sbList = (savedSb && Array.isArray(savedSb.tabs)) ? savedSb.tabs : [];
            // Multiset of live cwds: each live tab consumes one matching saved
            // entry, so projects with several saved tabs still restore fully.
            const liveByCwd = new Map();
            for (const id of session.tabMgr.order) {
                const t = session.tabMgr.tabs.get(id);
                if (t && t.cwd) liveByCwd.set(t.cwd, (liveByCwd.get(t.cwd) || 0) + 1);
            }
            const restoredTabs = [];
            let skipped = 0;
            saved.tabs.forEach((entry, i) => {
                const have = liveByCwd.get(entry.cwd) || 0;
                if (have > 0) { liveByCwd.set(entry.cwd, have - 1); skipped++; return; }
                const cwd = entry.cwd && fs.existsSync(entry.cwd) ? entry.cwd : undefined;
                const sb = sbList[i];
                const prior = (sb && sb.cwd === entry.cwd && typeof sb.scrollback === 'string') ? sb.scrollback : '';
                const label = entry.userRenamed && entry.title ? entry.title : (cwd || 'tab');
                const seed = prior
                    ? prior + `\r\n\x1b[2m── ${label} · context restored from previous session (fresh shell) ──\x1b[0m\r\n`
                    : '';
                const tab = session.tabMgr.open({
                    title: entry.userRenamed ? entry.title : undefined,
                    cwd,
                    env: shellEnv,
                    silent: true,
                    seedScrollback: seed || undefined,
                });
                if (tab && cwd) restoredTabs.push({ tab, cwd });
            });
            console.log(`restore-on-connect: rehydrated ${restoredTabs.length}/${saved.tabs.length} saved tab(s)`
                + (skipped ? ` (${skipped} already live)` : ''));
            // A fresh daemon respawns dead shells, so each tab's Claude
            // conversation is gone unless we resume it. Auto-resume the tabs
            // whose cwd has a recent transcript (SOA_WEB_NO_AUTO_RESUME=1 off).
            if (restoredTabs.length && process.env.SOA_WEB_NO_AUTO_RESUME !== '1') {
                scheduleAutoResume(restoredTabs);
            }
        }

        autoPilot.instance.attach(session.tabMgr, (tabId) => session._agentStatus && session._agentStatus.get(tabId) || 'idle');
    }

    try {
        const tabList = session.tabMgr.list();
        const activeId = (session.activeTab && tabList.some(t => t.id === session.activeTab))
            ? session.activeTab
            : (tabList[0] && tabList[0].id) || 0;
        // Replay scrollback so a reloading browser catches up on everything it
        // missed — tabs, which one was active, and accumulated output — before
        // any new term-data frames arrive. This is what makes a refresh
        // non-destructive.
        //
        // Send ONLY the active tab's scrollback inline with HELLO; stream every
        // other tab's scrollback as separate REPLAY frames afterwards. With
        // ~17 tabs × up to 256 KiB each, a single all-tabs HELLO is multiple MB.
        // A WebSocket frame is atomic on the wire: while that one frame crawls
        // over a slow mobile/tunnel link, NO ping/pong control frame can
        // interleave, so both the client's 9 s app-heartbeat and the server's
        // 5 s ws.ping() watchdog fire and tear the socket down — which
        // reconnects and resends the same giant frame: an endless reconnect
        // loop that also makes the terminal take "a minute" to appear. Split
        // into per-tab frames so heartbeats interleave → stable socket, and the
        // tab the user actually lands on paints immediately.
        const helloReplay = [];
        const activeData = session.tabMgr.scrollback(activeId);
        if (activeData && activeData.length) helloReplay.push({ id: activeId, data: activeData });
        ws.send(frame(MSG.HELLO, {
            serverVersion: 1,
            serverTime: Date.now(),
            tabs: tabList,
            activeId,
            replay: helloReplay,
            graveyard: session.tabMgr.graveyardList(),
            connectedDevices: session.sockets.size,
        }));
        dbg('ws-hello', 'sent to', ws._userAgent.slice(0, 40), '— tabs=' + tabList.length, 'activeId=' + activeId, 'activeReplayBytes=' + (activeData ? activeData.length : 0), 'devices=' + session.sockets.size);
        // Stream the remaining tabs' scrollback (active tab excluded — it went
        // out in HELLO). Best-effort, off the connect path.
        streamBackgroundReplay(ws, session, tabList, activeId);
        // Notify other clients that a new device joined
        _broadcastDeviceCount(session, ws);
    } catch (_) { /* ignore */ }

    ws.on('message', raw => {
        session.touch();
        // Any inbound frame proves the peer is alive — credit it the same way a
        // WS pong does. The mobile client app-pings every 4s, so a live socket
        // stays marked alive even when the browser's automatic control-frame
        // pong is momentarily queued behind a burst of terminal output.
        ws.isAlive = true;
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
                        graveyard: session.tabMgr.graveyardList(),
                        connectedDevices: session.sockets.size,
                    }));
                }
                break;
            case MSG.INPUT:
                handleInput(session, msg.d || {}, ws);
                break;
            default: /* forward-compat: ignore unknown types */ break;
        }
    });

    ws.on('close', () => {
        try { agentBrowser.unsubscribeAll(ws); } catch (_) {}
        session.detachSocket(ws);
        _broadcastDeviceCount(session);
    });
    ws.on('error', () => { /* close handler will fire too */ });
}

// Stream each background tab's scrollback as its own REPLAY frame, one at a
// time, yielding to the event loop between sends so WebSocket control frames
// (ping/pong) and the client's keepalive interleave instead of being stuck
// behind one multi-MB HELLO. Honours backpressure: if the socket's send buffer
// is already deep, wait for it to drain before queuing more. Best-effort —
// bails the moment the socket is no longer OPEN (closed, or reconnected with a
// fresh ws that will get its own stream).
const REPLAY_HIGH_WATER = 512 * 1024; // bytes buffered before we pause to drain
function streamBackgroundReplay(ws, session, tabList, activeId) {
    const ids = tabList.map(t => t.id).filter(id => id !== activeId);
    if (!ids.length) return;
    let i = 0;
    const sendNext = () => {
        if (!ws || ws.readyState !== 1) return; // socket gone / reconnected
        if (i >= ids.length) return;
        if (ws.bufferedAmount > REPLAY_HIGH_WATER) { setTimeout(sendNext, 50); return; }
        const id = ids[i++];
        let data = '';
        try { data = session.tabMgr.scrollback(id); } catch (_) {}
        if (data && data.length) {
            try { ws.send(frame(MSG.REPLAY, { id, data })); } catch (_) { return; }
        }
        setImmediate(sendNext);
    };
    setImmediate(sendNext);
}

// Auto-resume Claude in tabs restored after a daemon restart. The respawned
// shells are fresh (dead), so each tab's conversation is lost unless we resume
// it. For every restored tab whose cwd has a recent Claude transcript, type
//   claude --resume <latest-session> || claude --continue
// once the shell has had a moment to print its prompt, staggered so N claudes
// don't all cold-start at once. The project scan is deferred off the connect
// path. Disable with SOA_WEB_NO_AUTO_RESUME=1.
function scheduleAutoResume(restoredTabs) {
    setTimeout(() => {
        let map;
        try { map = claudeSessions.latestSessionByCwd(72); }
        catch (e) { dbg('auto-resume', 'scan failed', String((e && e.message) || e)); return; }
        let n = 0;
        for (const { tab, cwd } of restoredTabs) {
            const hit = map.get(cwd);
            if (!hit) continue;
            const wait = n * 1500; // stagger cold-starts
            n++;
            setTimeout(() => {
                // Shared launch helper: reliable split-write submit + the same
                // resume-vs-fresh chain the manager's `spawn` action uses, so
                // boot-restore and agent-spawn can't drift apart. No-op if the
                // PTY already exited.
                try { sessionManager.launchClaude(tab, cwd, { resume: true, sessionId: hit.sessionId, coldFallback: false }); } catch (_) {}
            }, wait);
        }
        if (n) dbg('auto-resume', `armed ${n}/${restoredTabs.length} restored tab(s)`);
    }, 1200);
}

function handleInput(session, d, ws) {
    const mgr = session.tabMgr;
    if (d.kind === INPUT_KIND.TERM_RESIZE) {
        dbg('input', 'TERM_RESIZE from device — tab=' + d.id, d.cols + 'x' + d.rows, '(shared pty resizes to MAX across live clients)');
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
            // Explicit user intent — lets the persist shrink-guard tell a real
            // "close my tabs" apart from a boot-race clobber.
            tabPersist.noteUserClose();
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
            if (!tab) break;
            const cols = Math.max(2, d.cols | 0);
            const rows = Math.max(2, d.rows | 0);
            // Remember THIS client's desired size for this tab.
            if (ws) {
                if (!ws._tabSizes) ws._tabSizes = new Map();
                ws._tabSizes.set(d.id, { cols, rows });
            }
            // Resize the SHARED pty to the LARGEST size any live client wants
            // for this tab — a narrow phone can then never clip the wide
            // desktop (the "black void on the right when a mobile is attached,
            // and it stays while the desktop is idle" bug). Smaller clients
            // just scroll/scale; the widest surface stays whole.
            let maxCols = cols, maxRows = rows;
            for (const sock of session.sockets) {
                if (!sock || sock.readyState !== 1 || !sock._tabSizes) continue;
                const sz = sock._tabSizes.get(d.id);
                if (!sz) continue;
                if (sz.cols > maxCols) maxCols = sz.cols;
                if (sz.rows > maxRows) maxRows = sz.rows;
            }
            tab.resize(maxCols, maxRows);
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
                'enter':  '\r', 'tab': '\t', 'backspace': '\x7f',
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
                try { sessionManager.ensure(session).reportCtx(d.id, pct); } catch (_) {}
            }
            break;
        }
        case INPUT_KIND.BROWSER_SUBSCRIBE:
            // d.id '*' = the monitor grid (watch every instance); otherwise watch
            // one tab's browser, defaulting to this device's active tab.
            if (d.id === '*') agentBrowser.subscribeAll(ws).catch(() => {});
            else agentBrowser.subscribe(d.id != null ? d.id : session.activeTab, ws).catch(() => {});
            break;
        case INPUT_KIND.BROWSER_UNSUBSCRIBE:
            if (d.id === '*') agentBrowser.unsubscribeAll(ws);
            else agentBrowser.unsubscribe(d.id != null ? d.id : session.activeTab, ws).catch(() => {});
            break;
        case INPUT_KIND.BROWSER_CLICK:
            agentBrowser.command(d.id != null ? d.id : session.activeTab, 'click', { x: Number(d.x), y: Number(d.y) }).catch(() => {});
            break;
        case INPUT_KIND.WINDOW_CONTROL:
            windowControl.applyPreset(String(d.preset || ''))
                .then(() => session.send(frame(MSG.NOTICE, { level: 'info', text: `Desktop window → ${d.preset}` })))
                .catch(err => session.send(frame(MSG.NOTICE, { level: 'warn', text: 'Window control: ' + (err && err.message || 'failed') })));
            break;
        default: /* ignore */ break;
    }
}

// Liveness watchdog. A socket is reaped only after it stays SILENT across
// several cycles — not after a single missed pong. On a high-latency mobile/
// tunnel link a pong can lag many seconds behind a burst of terminal output
// without the socket being dead; terminating on the first miss false-killed
// those laggy-but-live mobile sockets, which then reconnected and re-replayed
// every tab's scrollback — the "streaming is unstable, try again" symptom.
// `isAlive` is reset to true by EITHER a WS pong (ws.on('pong')) or any inbound
// message (ws.on('message')), so a genuinely live peer never accrues misses.
const HEARTBEAT_MS = 5000;
const MAX_MISSED_BEATS = 3; // ~15s of unbroken silence before we give up
const heartbeat = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) {
            ws._missedBeats = (ws._missedBeats || 0) + 1;
            if (ws._missedBeats >= MAX_MISSED_BEATS) { try { ws.terminate(); } catch (_) {} return; }
        } else {
            ws._missedBeats = 0;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch (_) {}
    });
}, HEARTBEAT_MS);
if (heartbeat.unref) heartbeat.unref();

// Persist scrollback to disk every 30s so even a *hard* crash (SIGKILL from
// the watchdog's `kickstart -k`, OOM, panic — none of which run the graceful
// shutdown flush below) loses at most ~30s of on-screen context. Metadata
// (titles, cwds) is already saved on every change; this captures the live PTY
// output — the actual session "memory" — for each tab. The write is a capped
// (128 KiB/tab) atomic tmp+rename, ~a few MB total (measured ~50ms p99 on a
// 30-tab fleet), so the tighter cadence is negligible I/O. Bump it up on slow
// network storage (e.g. SOA_WEB_SCROLLBACK_FLUSH_MS=120000) to reduce churn.
const SCROLLBACK_FLUSH_MS = parseInt(process.env.SOA_WEB_SCROLLBACK_FLUSH_MS || String(30 * 1000), 10);
// Flush only the session that actually owns tabs. Flushing every session
// last-writer-wins into the same two files, so an empty tabMgr (e.g. a WS
// client that bound while no session had tabs) iterated last would erase the
// real state on disk — this is what clobbered tabs.json on 2026-06-11.
// Intentional close-all still persists via the debounced onTabsChange save.
function persistableSession() {
    let best = null;
    for (const s of sessions.sessions.values()) {
        if (!s.tabMgr || s.tabMgr.order.length === 0) continue;
        if (!best || s.tabMgr.order.length > best.tabMgr.order.length) best = s;
    }
    return best;
}
const scrollbackFlush = setInterval(() => {
    const s = persistableSession();
    if (s) tabPersist.saveAll(s.tabMgr);
}, SCROLLBACK_FLUSH_MS);
if (scrollbackFlush.unref) scrollbackFlush.unref();

// Per-tab memory sampler. Every ~10s take ONE `ps` snapshot of all processes
// and sum each tab's process-tree RSS from its PTY pid (the shell + the agent
// running under it), then push a compact {id:bytes} frame to that session's
// clients for the tab hover tooltip. Resource-frugal by design: skip the ps
// call entirely when NO client is connected (nobody to show it to), and one
// snapshot serves every tab/session. memBytes is also stamped on each tab so a
// fresh HELLO/SNAPSHOT carries the last value immediately (tabManager.list).
const MEM_SAMPLE_MS = parseInt(process.env.SOA_WEB_MEM_SAMPLE_MS || String(10 * 1000), 10);
const memSample = setInterval(() => {
    try {
        let anyClients = false;
        for (const s of sessions.sessions.values()) {
            if (s.sockets && s.sockets.size) { anyClients = true; break; }
        }
        if (!anyClients) return; // nobody watching → don't spend a ps
        const snap = procMem.snapshot();
        for (const s of sessions.sessions.values()) {
            const mgr = s.tabMgr;
            if (!mgr || mgr.order.length === 0) continue;
            const mem = {};
            for (const id of mgr.order) {
                const t = mgr.tabs.get(id);
                if (!t || t.exited || !t.pty || !t.pty.pid) continue;
                const bytes = procMem.subtreeBytes(t.pty.pid, snap);
                t.memBytes = bytes;
                mem[id] = bytes;
            }
            if (s.sockets && s.sockets.size && Object.keys(mem).length) {
                try { s.send(frame(MSG.TAB_MEM, { mem })); } catch (_) {}
            }
        }
    } catch (_) { /* sampling is best-effort; never crash the daemon */ }
}, MEM_SAMPLE_MS);
if (memSample.unref) memSample.unref();

function shutdown(code = 0) {
    console.log('\nshutting down…');
    clearInterval(heartbeat);
    clearInterval(scrollbackFlush);
    clearInterval(memSample);
    // Persist tabs + scrollback before killing PTYs so the next boot can
    // seed each tab with what was on screen.
    const flushS = persistableSession();
    if (flushS) tabPersist.saveAll(flushS.tabMgr);
    // Detach (don't kill) the tunnel so it survives the restart and the next
    // boot re-adopts the same public URL — the mobile bridge stays reachable.
    try { pair.detach(); } catch (_) {}
    try { wss.close(); } catch (_) {}
    try { sessions.shutdown(); } catch (_) {}
    instanceLock.release();
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 5000).unref();
}
process.on('SIGINT',  () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// SIGHUP — re-read the persisted tunnel state and trust its CURRENT public URL
// for WS origin checks, WITHOUT a restart (which would kill every PTY). The
// soa-watchdog respawns cloudflared out-of-band when the tunnel zombies, minting
// a new random *.trycloudflare.com host each time; it then signals us so browsers
// on the new host stop getting 403'd on the /ws upgrade (the recurring "I only
// see a dead terminal after the URL changed"). Cheap + idempotent — safe to send
// on every watchdog cycle.
process.on('SIGHUP', () => {
    try {
        const f = require('./stateDir').stateFile('tunnel.json');
        const url = JSON.parse(fs.readFileSync(f, 'utf8')).url;
        if (url && !ALLOWED_ORIGINS.includes(url)) {
            ALLOWED_ORIGINS.push(url);
            console.log('SIGHUP: registered current tunnel origin for WS', url);
        } else {
            console.log('SIGHUP: tunnel origin already trusted', url || '(none)');
        }
    } catch (e) {
        console.log('SIGHUP: could not read tunnel.json:', e && e.message);
    }
});

// Self-heal on an in-process crash. An uncaughtException / unhandledRejection
// would otherwise tear the daemon down *without* running the flush above —
// losing up to SCROLLBACK_FLUSH_MS of on-screen session memory — and leave no
// trace of why it died. We can't safely keep serving from a corrupted state,
// so on a detected crash we: (1) best-effort synchronous flush so the next
// boot re-seeds every tab from what was on screen, (2) detach (not kill) the
// tunnel so the same public URL survives the restart, (3) append the reason to
// crash.log so the bounce is diagnosable, then (4) exit non-zero. launchd's
// unconditional KeepAlive (with the soa-watchdog as backstop) restarts the
// daemon in seconds, and tab/tunnel state is re-adopted on the way up.
let _crashing = false;
function crashFlush(kind, err) {
    if (_crashing) { try { process.exit(1); } catch (_) {} return; } // never loop
    _crashing = true;
    try { clearInterval(scrollbackFlush); } catch (_) {}
    try { clearInterval(heartbeat); } catch (_) {}
    try { clearInterval(memSample); } catch (_) {}
    try {
        const s = persistableSession();
        if (s) tabPersist.saveAll(s.tabMgr);            // sync atomic tmp+rename
    } catch (_) { /* already crashing — best effort */ }
    try { pair.detach(); } catch (_) {}
    try {
        const line = `${new Date().toISOString()} ${kind}: ${(err && err.stack) || err}\n`;
        fs.appendFileSync(path.join(STATE_DIR, 'logs', 'crash.log'), line);
    } catch (_) {}
    try { console.error(`SoA-Web ${kind} — flushed scrollback, exiting for supervised restart:`, err); } catch (_) {}
    process.exit(1);
}
process.on('uncaughtException',  (err) => crashFlush('uncaughtException', err));
process.on('unhandledRejection', (err) => crashFlush('unhandledRejection', err));

// Boot-time self-heal: a daemon restart only rehydrates the fleet (respawn PTYs
// + claude --resume) when a client connects to the primary session — so a restart
// with NO browser leaves the saved tabs dead on disk until someone connects (the
// "self-heal recovered tabs.json but the fleet is still down" gap). Here the
// daemon connects an internal loopback WS to ITSELF a few seconds after boot,
// carrying the persisted session's own cookie so it binds to THAT exact session,
// which drives the SAME battle-tested restore-on-connect path (open tabs, arm
// auto-resume). It then closes — tabs/PTYs live on the session, not the socket,
// so they persist. No-op if a real client already rehydrated, tabs.json is empty,
// or SOA_WEB_NO_BOOT_RESUME=1. Cookie targeting is what prevents a double-restore:
// a later browser using the same cookie binds to the same (now non-empty) session
// and skips restore.
function scheduleBootResume() {
    if (process.env.SOA_WEB_NO_BOOT_RESUME === '1') return;
    const delay = parseInt(process.env.SOA_WEB_BOOT_RESUME_DELAY_MS || '4000', 10);
    const MAX_ATTEMPTS = 3;
    // UNCONDITIONAL rehydration: the only thing that cancels an attempt is
    // proof the restore actually ran (_diskRestoreRan — set inside
    // restore-on-connect itself). The old heuristic — "the persisted session
    // has >0 tabs, so a client must have rehydrated" — was satisfied by a
    // client's own fresh tab and silently skipped the whole fleet
    // (2026-07-08). Every skip now says why, and failed attempts retry with
    // backoff instead of giving up for the life of the process.
    const attempt = (n) => {
        try {
            if (_diskRestoreRan) { console.log(`boot-resume[${n}]: restore-on-connect already ran — nothing to do`); return; }
            const saved = tabPersist.load();
            if (!saved || !Array.isArray(saved.tabs) || saved.tabs.length === 0) {
                console.log(`boot-resume[${n}]: no saved tabs on disk — nothing to rehydrate`);
                return;
            }
            console.log(`boot-resume[${n}/${MAX_ATTEMPTS}]: fleet not rehydrated yet — self-connecting to rehydrate ${saved.tabs.length} tab(s)`);
            const headers = {};
            if (_persistedSession && _persistedSession.token) {
                // Bind to the persisted primary session so the restored tabs
                // land where the user's existing cookie points.
                headers.Cookie = `${auth.COOKIE_NAME}=${encodeURIComponent(auth.issue(_persistedSession.token, SIGN_KEY))}`;
            } else {
                console.log(`boot-resume[${n}]: no persisted session — rehydrating into a fresh primary session`);
            }
            const url = `ws://127.0.0.1:${activePort}/ws` + (SESSION_TOKEN ? `?t=${encodeURIComponent(SESSION_TOKEN)}` : '');
            const probe = new WebSocket(url, { headers });
            probe.on('open', () => {
                // restore-on-connect runs synchronously inside onWsConnect; hold the
                // socket open briefly so the first auto-resume tick can fire, then close.
                setTimeout(() => { try { probe.close(); } catch (_) {} }, 4000);
            });
            probe.on('error', e => console.log(`boot-resume[${n}] self-connect failed:`, e && e.message));
        } catch (e) { console.log(`boot-resume[${n}] failed:`, e && e.message); }
        if (n < MAX_ATTEMPTS) {
            const r = setTimeout(() => { if (!_diskRestoreRan) attempt(n + 1); }, delay * 2 * n);
            if (r.unref) r.unref();
        }
    };
    const t = setTimeout(() => attempt(1), delay);
    if (t.unref) t.unref();
}

function onListening() {
    activePort = server.address().port;
    sysinfo.setSoaPort(activePort);
    tts.setPort(activePort);
    // Refresh the lock with the port we actually bound (may have hopped).
    instanceLock.acquireOrExit(activePort);
    console.log(`SoA-Web ready: http://${HOST}:${activePort}  [${MODE} · state: ${STATE_DIR}]`);

    // Headless self-heal: rehydrate the fleet even if no browser reconnects.
    scheduleBootResume();

    if (process.env.SOA_WEB_AUTOPAIR !== '0') {
        const registerTunnel = (url) => {
            if (url && !ALLOWED_ORIGINS.includes(url)) ALLOWED_ORIGINS.push(url);
        };
        // Try to re-adopt a tunnel that outlived the previous process first; only
        // mint a fresh one if there's nothing healthy to take over. Adoption keeps
        // the same public URL across restarts so the mobile client never loses it.
        pair.resume().then(snap => {
            if (snap.state === 'online' && snap.publicUrl) {
                registerTunnel(snap.publicUrl);
                console.log(`SoA-Web tunnel:  ${snap.publicUrl}  (re-adopted — survived restart)`);
                return;
            }
            return pair.start().then(snap2 => {
                if (snap2.state === 'online' && snap2.publicUrl) {
                    registerTunnel(snap2.publicUrl);
                    console.log(`SoA-Web tunnel:  ${snap2.publicUrl}  (QR in the sidebar)`);
                } else if (snap2.state === 'error') {
                    console.log(`SoA-Web tunnel:  unavailable — ${snap2.error}`);
                }
            });
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
