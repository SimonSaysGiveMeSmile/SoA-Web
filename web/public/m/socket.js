/**
 * BridgeSocket — robust WebSocket client for Son of Anton's mobile bridge.
 *
 * Goals:
 *   - Never give up. Once a session is paired, we keep trying to come back.
 *   - Tell the UI exactly what's going on (states + events).
 *   - Survive backgrounding (visibility change reconnect kick).
 *   - Heartbeat to detect silently-dead sockets.
 */

const PROTOCOL_VERSION = 1;

// Mobile-side bridge diagnostics. On by default so the phone's remote
// inspector (Safari Web Inspector / chrome://inspect) shows the full
// connection lifecycle without a rebuild. Flip ?debug=0 to silence.
const DEBUG = (() => {
    try {
        const p = new URLSearchParams(location.search).get('debug');
        if (p === '0') return false;
        if (p === '1') return true;
        const saved = localStorage.getItem('son-of-anton.debug');
        return saved !== '0';
    } catch (_) { return true; }
})();

// On-screen log ring buffer. A phone has no console, so every blog() line is
// also retained here for the in-app diagnostics panel (see app.js diag panel).
const LOG_BUFFER = [];
export function pushLog(line) {
    LOG_BUFFER.push({ t: Date.now(), line: String(line) });
    if (LOG_BUFFER.length > 200) LOG_BUFFER.shift();
}
export function getLogBuffer() { return LOG_BUFFER; }

function blog(...args) {
    let line;
    try {
        line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    } catch (_) { line = args.join(' '); }
    pushLog(line);
    if (DEBUG) console.log('%c[bridge]', 'color:#5fff5f', ...args);
}

export const SocketState = Object.freeze({
    IDLE:         'idle',
    CONNECTING:   'connecting',
    CONNECTED:    'connected',
    DISCONNECTED: 'disconnected',
    GIVING_UP:    'giving-up',
});

export const Diagnosis = Object.freeze({
    NONE:               'none',
    CONNECTED:          'connected',
    CAPTIVE_PORTAL:     'captive-portal',
    SERVER_UNREACHABLE: 'server-unreachable',
    NETWORK_OFFLINE:    'network-offline',
});

export class BridgeSocket extends EventTarget {
    constructor({ url, token, altUrls }) {
        super();
        // Ordered list of ws base URLs (scheme+host+port) we can try. The first
        // entry is the endpoint we were paired via (LAN if the QR came from a
        // LAN-primary desktop, otherwise the tunnel). Additional entries are
        // alternates — e.g. the PUB tunnel we discovered from `#alt=…` on the
        // QR or from /api/ping once paired. On a run of consecutive failures
        // we rotate to the next entry so a LAN→tunnel (or tunnel→LAN) flip
        // happens automatically without a re-scan.
        this._endpoints = [url, ...(altUrls || [])]
            .filter(Boolean)
            .filter((u, i, arr) => arr.indexOf(u) === i)
            .filter(u => _isEligibleWsScheme(u));
        this._endpointIdx = 0;
        this.baseUrl = this._endpoints[0] || url;
        this.token = token;
        blog('init — endpoints:', this._endpoints, 'token:', token ? '(present)' : '(none)', 'pageProto:', location.protocol);
        if (this._endpoints.length === 0) {
            blog('WARNING: no eligible ws endpoints. On an https page, ws:// LAN URLs are dropped (mixed content) — only a wss:// tunnel works.');
        }
        this.state = SocketState.IDLE;
        this.diagnosis = Diagnosis.NONE;
        this.ws = null;
        this._attempt = 0;
        this._failuresOnCurrent = 0;
        this._stop = false;
        this._reconnectTimer = null;
        this._heartbeatTimer = null;
        this._livenessTimer = null;
        this._lastPongAt = 0;
        // Any inbound frame proves the socket is alive — not just a pong. During
        // the initial scrollback stream the server may send several large REPLAY
        // frames back-to-back; tracking last-received-anything keeps the
        // heartbeat from killing a perfectly healthy socket whose pong is merely
        // queued behind that burst.
        this._lastRecvAt = 0;
        this._probeController = null;

        // Resuming from background / lock screen / bfcache. The socket may look
        // OPEN but actually be dead (iOS freezes JS, so readyState is stale and
        // our heartbeat didn't run). Don't trust state === CONNECTED — actively
        // verify with a ping and reconnect fast if it's a corpse.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') this._verifyLiveOrReconnect();
        });
        window.addEventListener('focus', () => this._verifyLiveOrReconnect());
        // pageshow with persisted=true means the page came back from the bfcache
        // — its WebSocket is always dead. Force a fresh connection.
        window.addEventListener('pageshow', (e) => {
            if (e && e.persisted) this._scheduleReconnect(0);
            else this._verifyLiveOrReconnect();
        });

        window.addEventListener('online', () => {
            if (this.state !== SocketState.CONNECTED) this._scheduleReconnect(0);
            else this._verifyLiveOrReconnect();
        });
        window.addEventListener('offline', () => {
            this._setDiagnosis(Diagnosis.NETWORK_OFFLINE);
        });

        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (conn) {
            conn.addEventListener('change', () => {
                if (this.state !== SocketState.CONNECTED) this._scheduleReconnect(0);
            });
        }
    }

    connect() {
        this._stop = false;
        this._open();
    }

    close() {
        this._stop = true;
        this._clearTimers();
        if (this.ws) {
            try { this.ws.close(1000, 'client closed'); } catch (_) {}
        }
        this._setState(SocketState.IDLE);
    }

    send(typeOrFrame, data, id) {
        if (!this.ws || this.ws.readyState !== 1) return false;
        const f = typeof typeOrFrame === 'string'
            ? { v: PROTOCOL_VERSION, t: typeOrFrame, d: data || {} }
            : typeOrFrame;
        if (id) f.id = id;
        try {
            this.ws.send(JSON.stringify(f));
            return true;
        } catch (_) { return false; }
    }

    sendInput(kind, payload = {}) {
        return this.send('input', Object.assign({ kind }, payload));
    }

    retryNow() {
        this._attempt = 0;
        this._scheduleReconnect(0);
    }

    // Decide, on resume, whether the live socket is actually usable. If we're not
    // cleanly OPEN, reconnect now. If we LOOK connected, prove it: send a ping and
    // if no pong lands in 2.5s, treat the socket as dead and reconnect. This is
    // what closes the "page came back but the session is silently gone" gap on
    // iOS without waiting for the slow heartbeat.
    _verifyLiveOrReconnect() {
        if (this._stop) return;
        // A connect is already underway — let it finish rather than restarting it.
        if (this.state === SocketState.CONNECTING) return;
        if (this.state !== SocketState.CONNECTED || !this.ws || this.ws.readyState !== 1) {
            this._scheduleReconnect(0);
            return;
        }
        const sinceBefore = this._lastPongAt;
        try { this.send('ping', { ts: Date.now() }); } catch (_) {}
        if (this._livenessTimer) clearTimeout(this._livenessTimer);
        this._livenessTimer = setTimeout(() => {
            if (this._stop) return;
            // No pong arrived since we asked → the socket is a corpse.
            if (this._lastPongAt <= sinceBefore) {
                blog('resume liveness check failed — socket is stale, reconnecting');
                try { this.ws && this.ws.close(4001, 'stale after resume'); } catch (_) {}
                this._scheduleReconnect(0);
            }
        }, 2500);
    }

    /** Merge newly-discovered endpoints (e.g. from /api/ping) into the pool. */
    addEndpoints(urls) {
        if (!Array.isArray(urls)) return;
        let changed = false;
        for (const u of urls) {
            if (!u) continue;
            if (!_isEligibleWsScheme(u)) continue;
            if (!this._endpoints.includes(u)) {
                this._endpoints.push(u);
                changed = true;
            }
        }
        if (changed) {
            this.dispatchEvent(new CustomEvent('endpoints-changed', {
                detail: { endpoints: this._endpoints.slice() },
            }));
        }
    }

    /** Jump to the next endpoint in the pool immediately, if one exists. */
    _rotateEndpoint() {
        if (this._endpoints.length < 2) return false;
        this._endpointIdx = (this._endpointIdx + 1) % this._endpoints.length;
        this.baseUrl = this._endpoints[this._endpointIdx];
        this._failuresOnCurrent = 0;
        blog('rotate → endpoint[' + this._endpointIdx + ']', this.baseUrl);
        this.dispatchEvent(new CustomEvent('endpoint-switched', {
            detail: { url: this.baseUrl, index: this._endpointIdx },
        }));
        return true;
    }

    _setDiagnosis(diag) {
        if (this.diagnosis === diag) return;
        this.diagnosis = diag;
        this.dispatchEvent(new CustomEvent('diagnosis', { detail: { diagnosis: diag } }));
    }

    _setState(state, detail) {
        if (this.state === state) return;
        this.state = state;
        this.dispatchEvent(new CustomEvent('state', { detail: { state, ...(detail || {}) } }));
    }

    _open() {
        this._clearTimers();
        const url = this.token
            ? `${this.baseUrl}/ws?t=${encodeURIComponent(this.token)}`
            : `${this.baseUrl}/ws`;
        this._setState(SocketState.CONNECTING, { attempt: this._attempt + 1 });
        blog('open → probing', this.baseUrl, '(attempt', this._attempt + 1 + ')');

        this._probeConnectivity().then(diag => {
            if (this._stop) return;
            blog('probe result:', diag, 'for', this.baseUrl);
            this._setDiagnosis(diag);

            if (diag === Diagnosis.NETWORK_OFFLINE || diag === Diagnosis.CAPTIVE_PORTAL) {
                blog('blocked by', diag, '— not opening ws, scheduling retry');
                this._scheduleReconnect();
                return;
            }

            // Probe says the current endpoint is unreachable but the internet
            // works — try the next endpoint (LAN ↔ tunnel failover) instead
            // of burning another WS handshake on the same dead host.
            if (diag === Diagnosis.SERVER_UNREACHABLE) {
                this._failuresOnCurrent += 1;
                blog('server unreachable (', this._failuresOnCurrent, 'strikes on this endpoint )');
                if (this._failuresOnCurrent >= 2 && this._rotateEndpoint()) {
                    this._scheduleReconnect(0);
                    return;
                }
                this._scheduleReconnect();
                return;
            }

            let ws;
            try {
                blog('probe OK — opening WebSocket to', url);
                ws = new WebSocket(url);
            } catch (e) {
                blog('WebSocket constructor threw:', e && e.message);
                this._scheduleReconnect();
                return;
            }
            this.ws = ws;

            ws.addEventListener('open', () => {
                blog('WS OPEN ✓', this.baseUrl);
                this._attempt = 0;
                this._failuresOnCurrent = 0;
                this._lastPongAt = Date.now();
                this._lastRecvAt = Date.now();
                this._setDiagnosis(Diagnosis.CONNECTED);
                this._setState(SocketState.CONNECTED);
                this._startHeartbeat();
                this.send('request', { what: 'snapshot' });
                this._refreshEndpointsFromServer();
            });

            ws.addEventListener('message', (ev) => {
                this._lastRecvAt = Date.now();
                let msg;
                try { msg = JSON.parse(ev.data); }
                catch (_) { return; }
                if (!msg || typeof msg.t !== 'string') return;
                if (msg.t === 'pong') {
                    this._lastPongAt = Date.now();
                    return;
                }
                if (DEBUG) {
                    const sz = typeof ev.data === 'string' ? ev.data.length : 0;
                    if (msg.t === 'term-data') blog('recv term-data tab=' + (msg.d && msg.d.id), sz + 'B');
                    else blog('recv', msg.t, sz + 'B');
                }
                this.dispatchEvent(new CustomEvent('message', { detail: msg }));
            });

            ws.addEventListener('error', () => { blog('WS error event (close will follow)'); });

            ws.addEventListener('close', (ev) => {
                blog('WS CLOSE code=' + ev.code, 'reason=' + (ev.reason || '(none)'), 'wasConnected=' + (this.state === SocketState.CONNECTED));
                this._stopHeartbeat();
                this.ws = null;
                if (this._stop) {
                    this._setState(SocketState.IDLE, { code: ev.code });
                    return;
                }
                // Never managed to fully connect, or disconnected almost
                // immediately — treat as a failure on the current endpoint
                // and rotate after two strikes.
                if (this.state !== SocketState.CONNECTED) {
                    this._failuresOnCurrent += 1;
                    if (this._failuresOnCurrent >= 2) this._rotateEndpoint();
                }
                this._setState(SocketState.DISCONNECTED, { code: ev.code, reason: ev.reason });
                this._scheduleReconnect();
            });
        });
    }

    // Called right after a successful connect. Asks the desktop for its full
    // set of endpoints so we learn about a tunnel that came up after pairing,
    // or a new LAN IP after the desktop switched networks.
    async _refreshEndpointsFromServer() {
        try {
            const httpOrigin = this.baseUrl.replace(/^ws(s?):\/\//, 'http$1://');
            const res = await fetch(httpOrigin + '/api/ping', { cache: 'no-store' });
            if (!res.ok) return;
            const body = await res.json().catch(() => null);
            const ep = body && body.endpoints;
            if (!ep) return;
            const toWs = (o) => o ? o.replace(/^http(s?):\/\//, 'ws$1://') : null;
            this.addEndpoints([toWs(ep.lan), toWs(ep.public)].filter(Boolean));
        } catch (_) {}
    }

    async _probeConnectivity() {
        if (!navigator.onLine) return Diagnosis.NETWORK_OFFLINE;

        if (this._probeController) this._probeController.abort();
        this._probeController = new AbortController();
        const signal = this._probeController.signal;
        const timeoutId = setTimeout(() => this._probeController.abort(), 6000);

        const httpOrigin = this.baseUrl.replace(/^ws(s?):\/\//, 'http$1://');

        try {
            const res = await fetch(httpOrigin + '/api/ping', {
                signal, cache: 'no-store',
            });
            clearTimeout(timeoutId);
            if (res.ok) {
                const body = await res.json().catch(() => null);
                if (body && body.ok) return Diagnosis.CONNECTED;
            }
            blog('probe: /api/ping returned', res.status, '→ treating as captive portal');
            return Diagnosis.CAPTIVE_PORTAL;
        } catch (e) {
            blog('probe: /api/ping fetch failed (', e && e.name, ') — checking internet reachability');
            // Server unreachable — check internet to classify further
        }

        try {
            const res = await fetch('http://connectivitycheck.gstatic.com/generate_204', {
                signal, mode: 'no-cors', cache: 'no-store', redirect: 'manual',
            });
            clearTimeout(timeoutId);
            if (res.type === 'opaqueredirect') return Diagnosis.CAPTIVE_PORTAL;
            return Diagnosis.SERVER_UNREACHABLE;
        } catch (_) {
            clearTimeout(timeoutId);
            return navigator.onLine ? Diagnosis.CAPTIVE_PORTAL : Diagnosis.NETWORK_OFFLINE;
        }
    }

    _scheduleReconnect(forcedDelayMs) {
        if (this._stop) return;
        this._clearTimers();
        this._attempt += 1;
        const delay = (forcedDelayMs != null)
            ? forcedDelayMs
            : Math.min(30000, 250 * Math.pow(1.7, Math.min(this._attempt - 1, 12)));
        this.dispatchEvent(new CustomEvent('reconnect-scheduled', { detail: { delay, attempt: this._attempt } }));
        this._reconnectTimer = setTimeout(() => this._open(), delay);
    }

    _startHeartbeat() {
        this._stopHeartbeat();
        this._heartbeatTimer = setInterval(() => {
            // Dead only if we've heard NOTHING (no pong, no data frame) in 9s.
            // Using last-received-anything — not last-pong — means a long burst
            // of inbound frames keeps the socket considered alive even if its
            // pong is momentarily queued behind them.
            const lastSeen = Math.max(this._lastPongAt, this._lastRecvAt);
            if (Date.now() - lastSeen > 9000) {
                try { this.ws && this.ws.close(4000, 'heartbeat timeout'); } catch (_) {}
                return;
            }
            this.send('ping', { ts: Date.now() });
        }, 4000);
    }

    _stopHeartbeat() {
        if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
    }

    _clearTimers() {
        if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
        if (this._livenessTimer) { clearTimeout(this._livenessTimer); this._livenessTimer = null; }
    }
}

// Browsers refuse to open ws:// from an https:// page (mixed content). Drop
// endpoints we wouldn't be allowed to contact so rotation can't stall on one.
function _isEligibleWsScheme(u) {
    if (location.protocol !== 'https:') return true;
    return /^wss:/i.test(u);
}
