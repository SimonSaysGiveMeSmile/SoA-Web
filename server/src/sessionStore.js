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

const DEFAULT_IDLE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

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
        this.sockets = new Set();    // all live browser sockets for this session
        // Read-only share viewers, keyed by tabId. These are NOT in `sockets`,
        // so they never receive the full session broadcast (other tabs, manager
        // frames, etc.) — only the one tab's output, fanned in via
        // sendToShareViewers(). Kept separate so the normal hot path is untouched.
        this.shareViewers = new Map(); // tabId -> Set<ws>
    }

    touch() { this.lastSeen = Date.now(); }

    attachSocket(ws) { this.sockets.add(ws); }

    detachSocket(ws) { this.sockets.delete(ws); }

    send(frameStr) {
        let delivered = 0;
        for (const ws of this.sockets) {
            if (!ws || ws.readyState !== 1 /* OPEN */) continue;
            try { ws.send(frameStr); delivered++; } catch (_) { /* drop */ }
        }
        return delivered > 0;
    }

    addShareViewer(tabId, ws) {
        const key = Number(tabId);
        if (!this.shareViewers.has(key)) this.shareViewers.set(key, new Set());
        this.shareViewers.get(key).add(ws);
    }

    removeShareViewer(tabId, ws) {
        const set = this.shareViewers.get(Number(tabId));
        if (!set) return;
        set.delete(ws);
        if (!set.size) this.shareViewers.delete(Number(tabId));
    }

    // Fan a single tab's frame out to its read-only viewers only.
    sendToShareViewers(tabId, frameStr) {
        const set = this.shareViewers.get(Number(tabId));
        if (!set) return;
        for (const ws of set) {
            if (!ws || ws.readyState !== 1 /* OPEN */) continue;
            try { ws.send(frameStr); } catch (_) { /* drop */ }
        }
    }
}

class SessionStore {
    constructor({ idleTtlMs = DEFAULT_IDLE_TTL_MS, sweepMs } = {}) {
        this.sessions = new Map();   // id -> Session
        this.byToken  = new Map();   // token -> Session
        this.idleTtlMs = idleTtlMs;
        // Sweep cadence is configurable so the stress harness can exercise the
        // idle-GC path in seconds instead of waiting the 60s production default
        // (SOA_WEB_GC_SWEEP_MS). No behavioural change in prod.
        const sweep = sweepMs || parseInt(process.env.SOA_WEB_GC_SWEEP_MS || '60000', 10);
        this._sweep = setInterval(() => this.gc(), sweep);
        if (this._sweep.unref) this._sweep.unref();
    }

    create({ id: forcedId, token: forcedToken } = {}) {
        const id = forcedId || crypto.randomBytes(12).toString('base64url');
        const s = new Session(id);
        if (forcedToken) {
            this.byToken.delete(s.token);
            s.token = forcedToken;
        }
        this.sessions.set(id, s);
        this.byToken.set(s.token, s);
        return s;
    }

    get(id)          { return this.sessions.get(id) || null; }
    getByToken(tok)  { return tok ? (this.byToken.get(tok) || null) : null; }

    destroy(session) {
        if (!session) return;
        if (session._cwdInterval) clearInterval(session._cwdInterval);
        if (session._managerInterval) clearInterval(session._managerInterval);
        if (session._scrollbackInterval) clearInterval(session._scrollbackInterval);
        // The SessionManager owns its own 15s schedule timer (and parked watch
        // waiters) — tear it down too, else it fires forever and pins this session.
        if (session._manager && typeof session._manager.destroy === 'function') {
            try { session._manager.destroy(); } catch (_) {}
        }
        if (session.tabMgr && typeof session.tabMgr.killAll === 'function') {
            try { session.tabMgr.killAll(); } catch (_) {}
        }
        for (const tab of session.tabs) { try { tab.kill(); } catch (_) {} }
        this.sessions.delete(session.id);
        this.byToken.delete(session.token);
        for (const ws of session.sockets) {
            try { ws.close(1000, 'session-destroyed'); } catch (_) {}
        }
        session.sockets.clear();
    }

    gc(now = Date.now()) {
        // Test-only: SOA_WEB_GC_REAP_LIVE=1 reproduces the pre-fix idle-GC
        // clobber (reaps live fleets) so the stress harness can A/B the fix.
        // Never set in production.
        const reapLive = process.env.SOA_WEB_GC_REAP_LIVE === '1';
        for (const s of this.sessions.values()) {
            if (now - s.lastSeen <= this.idleTtlMs) continue;
            // Never idle-reap a session that still owns live tabs. Those PTYs are
            // a running fleet (often unattended agents working on their own), not
            // an abandoned browser tab. Reaping it would killAll() every PTY and
            // the next empty persist then clobbers tabs.json — the recurring
            // "came back and all my tabs were gone" loss after the fleet ran a
            // while with no browser attached. A fleet only goes away on an
            // explicit close, never on idle.
            if (!reapLive && s.tabMgr && s.tabMgr.order && s.tabMgr.order.length > 0) continue;
            this.destroy(s);
        }
    }

    shutdown() {
        clearInterval(this._sweep);
        for (const s of Array.from(this.sessions.values())) this.destroy(s);
    }
}

module.exports = { Session, SessionStore };
