/**
 * Session Manager — a server-side supervisor over ALL tabs in a session.
 *
 * Always-on: it runs in the daemon, independent of any connected client, so the
 * fleet is watched even when no phone or desktop is open. For every tab it:
 *   - classifies agent status from the live PTY stream (working / attention /
 *     done / idle),
 *   - tracks context % (best-effort from the stream; refined by client reports),
 *   - derives management signals: needs-attention, stuck, idle, high-context,
 *   - broadcasts a MANAGER snapshot to the session's clients (dashboard summary).
 *
 * It is also the data/action source for `soa-sessions`, the CLI a *manager agent*
 * (a dedicated Claude session with its own context) uses to read and act on every
 * other session — list them, read their recent output, send input, compact.
 */

const express = require('express');
const { MSG, frame } = require('./protocol');

// ── Stream detectors (ported from web/public/m/agentDetect.js; keep in sync) ──
const WORKING = [
    /esc to interrupt/i,
    /\(esc\s+to\s+cancel\)/i,
    /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
    /✳/,
    /\b(?:Thinking|Pondering|Crafting|Running|Executing|Processing|Working|Reading|Writing|Editing|Searching|Fetching|Analyzing|Compiling|Installing|Building|Testing|Formatting|Linting|Deploying|Pushing|Pulling|Cloning|Downloading|Uploading|Generating|Updating|Checking|Scanning|Indexing|Resolving|Compacting|Streaming|Connecting|Loading|Preparing|Initializing|Starting|Applying|Committing|Merging|Rebasing|Diffing)\b[.…]/i,
];
const ATTENTION = [
    /❯\s*(?:Yes|No|Allow once|Allow always|Deny|Accept|Reject)/i,
    /Do you want to (?:proceed|continue|make this change|accept)/i,
    /\(y\/n\)/i, /\[Y\/n\]/i, /\(Y\)es\s*\/\s*\(N\)o/i,
    /waiting\s+for\s+(?:your\s+)?input/i,
    /Allow\s+(?:Read|Write|Edit|Bash|Execute|NotebookEdit|WebFetch|WebSearch|Agent|LSP|Monitor)\b/i,
    /\bPermission\s+(?:required|needed)\b/i,
    /press\s+.*\s+to\s+(?:allow|approve|confirm)/i,
];
const DONE = [/╭─+╮/, /│\s*>\s*│/, /╰─+╯/, /│\s*>\s*$/m, /BYPASS PERMISSIONS\s+ON/i];
const SHELL_PROMPT = /(?:^|\n)[^\n]{0,80}?(?:[➜❯▶►»](?:\s|$)|[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+[^\n]*[$#%]\s*$)/m;

function strip(s) {
    return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '')
            .replace(/\x1b[()][AB012]/g, '');
}
function classifyAgent(recent, current) {
    const tail = strip(recent).slice(-600);
    if (WORKING.some(p => p.test(tail)))   return 'working';
    if (ATTENTION.some(p => p.test(tail))) return 'attention';
    if (DONE.some(p => p.test(tail)))      return 'done';
    if (SHELL_PROMPT.test(tail.slice(-200))) return (current && current !== 'idle') ? 'idle' : null;
    return null;
}
function extractCtxPct(text) {
    if (!text) return null;
    const clamp = n => Math.min(100, Math.max(0, Math.round(n)));
    const lines = strip(String(text)).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i];
        if (!t || t.indexOf('%') === -1) continue;
        let m;
        if ((m = t.match(/(\d{1,3})\s*%\s*context\s*used/i)))                  return clamp(+m[1]);
        if ((m = t.match(/context\s*used\s*[:\-]?\s*(\d{1,3})\s*%/i)))          return clamp(+m[1]);
        if ((m = t.match(/(\d{1,3})\s*%\s+(?:left\s+)?until\s+auto-?compact/i))) return clamp(100 - +m[1]);
        if ((m = t.match(/context\s+left\s*[:\-]?\s*(\d{1,3})\s*%/i)))          return clamp(100 - +m[1]);
        if ((m = t.match(/(\d{1,3})\s*%\s+context\s+(?:left|remaining)/i)))     return clamp(100 - +m[1]);
        if (/context/i.test(t) && (m = t.match(/[█▓▒░]\s*(\d{1,3})\s*%/)))      return clamp(+m[1]);
        if ((m = t.match(/[█▓▒░]{3,}\s*(\d{1,3})\s*%/)))                       return clamp(+m[1]);
        if ((m = t.match(/context[^%\d]{0,24}?(\d{1,3})\s*%/i)))               return clamp(+m[1]);
    }
    return null;
}

const STUCK_MS    = 4 * 60 * 1000;   // working but silent this long → stuck
const HIGH_CTX    = 80;              // context % considered "high"

class SessionManager {
    constructor(session) {
        this.session = session;
        this.tabs = new Map();       // tabId → state
    }

    _state(id) {
        let s = this.tabs.get(id);
        if (!s) {
            s = { status: 'idle', ctxPct: null, recent: '', lastOutputAt: 0, lastStatusAt: 0 };
            this.tabs.set(id, s);
        }
        return s;
    }

    // Fed from the PTY stream for every tab (see index.js onData).
    feed(id, data) {
        const s = this._state(id);
        s.lastOutputAt = Date.now();
        s.recent = (s.recent + data).slice(-6000);
        const next = classifyAgent(s.recent, s.status);
        if (next && next !== s.status) { s.status = next; s.lastStatusAt = Date.now(); }
        const pct = extractCtxPct(s.recent);
        if (pct != null) s.ctxPct = pct;
    }

    // Clients (desktop/mobile) can report an authoritative ctx reading.
    reportCtx(id, pct) {
        if (Number.isFinite(pct)) this._state(id).ctxPct = Math.min(100, Math.max(0, Math.round(pct)));
    }

    forget(id) { this.tabs.delete(id); }

    // Build the supervisor view of every live tab.
    snapshot() {
        const mgr = this.session.tabMgr;
        const order = mgr ? mgr.order : [];
        const now = Date.now();
        const sessions = order.map(id => {
            const tab = mgr.get(id);
            const s = this._state(id);
            const stuck = s.status === 'working' && s.lastOutputAt > 0 && (now - s.lastOutputAt) > STUCK_MS;
            return {
                id,
                title: (tab && tab.title) || `tab ${id}`,
                status: s.status,
                ctxPct: s.ctxPct,
                attention: s.status === 'attention',
                idle: s.status === 'idle' || s.status === 'done',
                stuck,
                highContext: s.ctxPct != null && s.ctxPct >= HIGH_CTX,
                idleMs: s.lastOutputAt ? now - s.lastOutputAt : null,
            };
        });
        const counts = {
            total: sessions.length,
            working: sessions.filter(x => x.status === 'working').length,
            attention: sessions.filter(x => x.attention).length,
            stuck: sessions.filter(x => x.stuck).length,
            idle: sessions.filter(x => x.idle).length,
            highContext: sessions.filter(x => x.highContext).length,
        };
        return { sessions, counts, ts: now };
    }

    broadcast() {
        try { this.session.send(frame(MSG.MANAGER, this.snapshot())); } catch (_) {}
    }
}

// Attach a manager to a session (idempotent).
function ensure(session) {
    if (!session._manager) session._manager = new SessionManager(session);
    return session._manager;
}

// ── soa-sessions backing API (loopback) + manager config ────────────────────
// Operates on the primary session's tabMgr so a manager agent in any tab can
// see and drive the whole fleet.
function mount(app, requireAuthed, sessions) {
    function primary() {
        for (const s of sessions.sessions.values()) {
            if (s.tabMgr && s.tabMgr.order.length > 0) return s;
        }
        return null;
    }
    function isLoopback(req) {
        const ip = (req.ip || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
        return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
    }

    // Read-only fleet view (authed; powers the dashboard too).
    app.get('/api/manager', requireAuthed, (req, res) => {
        const s = req.session && req.session.tabMgr ? req.session : primary();
        if (!s) return res.json({ ok: true, sessions: [], counts: {} });
        res.json({ ok: true, ...ensure(s).snapshot() });
    });

    // Action surface for the manager agent (loopback only — same trust model as
    // /api/tts). list | read | send | compact.
    app.post('/api/sessions', express.json({ limit: '64kb' }), (req, res) => {
        if (!isLoopback(req)) return res.status(403).json({ ok: false, error: 'loopback only' });
        const s = primary();
        if (!s || !s.tabMgr) return res.status(503).json({ ok: false, error: 'no active session' });
        const mgr = s.tabMgr;
        const man = ensure(s);
        const body = req.body || {};
        const action = String(body.action || '');
        try {
            if (action === 'list') {
                return res.json({ ok: true, ...man.snapshot() });
            }
            if (action === 'read') {
                const id = Number(body.id);
                const tab = mgr.get(id);
                if (!tab) return res.status(404).json({ ok: false, error: 'tab not found' });
                const n = Math.max(1, Math.min(400, Number(body.lines) || 80));
                const raw = strip(mgr.scrollback(id) || '');
                const tail = raw.split('\n').filter(l => l.trim()).slice(-n).join('\n');
                const st = man._state(id);
                return res.json({ ok: true, id, title: tab.title, status: st.status, ctxPct: st.ctxPct, text: tail });
            }
            if (action === 'send') {
                const id = Number(body.id);
                const tab = mgr.get(id);
                if (!tab) return res.status(404).json({ ok: false, error: 'tab not found' });
                const text = String(body.text || '');
                const submit = body.submit !== false;   // default: press Enter
                tab.write(text + (submit ? '\r' : ''));
                return res.json({ ok: true, id, sent: text.length });
            }
            if (action === 'compact') {
                const id = Number(body.id);
                const tab = mgr.get(id);
                if (!tab) return res.status(404).json({ ok: false, error: 'tab not found' });
                tab.write('/compact\r');
                return res.json({ ok: true, id, compacted: true });
            }
            return res.status(400).json({ ok: false, error: 'unknown action: ' + action });
        } catch (err) {
            return res.status(500).json({ ok: false, error: (err && err.message) || 'failed' });
        }
    });
}

module.exports = { SessionManager, ensure, mount, classifyAgent, extractCtxPct };
