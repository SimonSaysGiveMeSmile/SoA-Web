/**
 * SessionStore
 *
 * Per-browser session state. Each session owns:
 *   - a signed token (set as an HttpOnly cookie on first HTTP hit)
 *   - a pool of PTY-backed tabs
 *   - the active WebSocket (at most one; extra connects replace the old one so
 *     a user refreshing the page doesn't leak PTYs)
 *
 * On the desktop app, PTYs were owned by the Electron main process on behalf
 * of a single trusted user. Here the server owns them on behalf of whichever
 * browser presents the session cookie. The token is random 256-bit, rotated
 * never by default — each browser tab sees the same session as long as the
 * cookie sticks. The `SOA_WEB_SESSION_TTL_MS` env var caps idle time.
 */

const crypto = require('crypto');

const DEFAULT_IDLE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

function newToken() {
    return crypto.randomBytes(32).toString('base64url');
}

class Session {
    constructor(id) {
        this.id = id;
        this.token = newToken();
        this.createdAt = Date.now();
        this.lastSeen  = Date.now();
        this.tabs = [];              // array of Tab instances (see tabManager.js)
        this.activeTab = 0;
        this.ws = null;              // single active browser socket
    }

    touch() { this.lastSeen = Date.now(); }

    attachSocket(ws) {
        if (this.ws && this.ws !== ws) {
            try { this.ws.close(1000, 'superseded'); } catch (_) { /* ignore */ }
        }
        this.ws = ws;
    }

    detachSocket(ws) {
        if (this.ws === ws) this.ws = null;
    }

    send(frameStr) {
        if (!this.ws) return false;
        if (this.ws.readyState !== 1 /* OPEN */) return false;
        try { this.ws.send(frameStr); return true; } catch (_) { return false; }
    }
}

class SessionStore {
    constructor({ idleTtlMs = DEFAULT_IDLE_TTL_MS } = {}) {
        this.sessions = new Map();   // id -> Session
        this.byToken  = new Map();   // token -> Session
        this.idleTtlMs = idleTtlMs;
        this._sweep = setInterval(() => this.gc(), 60_000);
        if (this._sweep.unref) this._sweep.unref();
    }

    create() {
        const id = crypto.randomBytes(12).toString('base64url');
        const s = new Session(id);
        this.sessions.set(id, s);
        this.byToken.set(s.token, s);
        return s;
    }

    get(id)          { return this.sessions.get(id) || null; }
    getByToken(tok)  { return tok ? (this.byToken.get(tok) || null) : null; }

    destroy(session) {
        if (!session) return;
        for (const tab of session.tabs) { try { tab.kill(); } catch (_) {} }
        this.sessions.delete(session.id);
        this.byToken.delete(session.token);
        if (session.ws) { try { session.ws.close(1000, 'session-destroyed'); } catch (_) {} }
    }

    gc(now = Date.now()) {
        for (const s of this.sessions.values()) {
            if (now - s.lastSeen > this.idleTtlMs) this.destroy(s);
        }
    }

    shutdown() {
        clearInterval(this._sweep);
        for (const s of Array.from(this.sessions.values())) this.destroy(s);
    }
}

module.exports = { Session, SessionStore };
