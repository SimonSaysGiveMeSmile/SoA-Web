/**
 * PairingManager
 *
 * Owns the public tunnel lifecycle and collects URLs + QR payloads for the
 * browser to render. One tunnel at a time per process — if a user toggles
 * pairing while one is already up, the old tunnel is closed first.
 *
 * QR payloads: we encode the *landing URL* (LAN IP or tunnel URL, whichever
 * the browser asks for). The phone scans, opens the SPA, and authenticates
 * with the same shared secret the desktop user used. No new auth flow.
 */

const os = require('os');
const { openTunnel, adopt } = require('./tunnel');

function lanAddresses(port, proto = 'http') {
    const out = [];
    const ifaces = os.networkInterfaces() || {};
    for (const addrs of Object.values(ifaces)) {
        for (const a of (addrs || [])) {
            if (a.internal) continue;
            if (a.family !== 'IPv4' && a.family !== 4) continue;
            out.push(`${proto}://${a.address}:${port}`);
        }
    }
    return out;
}

class PairingManager {
    constructor({ port, publicProto = 'http', bindHost = '0.0.0.0', openTunnel: openTunnelImpl = openTunnel, adopt: adoptImpl = adopt, restartDelayMs = 5000 }) {
        this.port = port;
        this._openTunnel = openTunnelImpl;
        this._adopt = adoptImpl;
        this._restartDelayMs = restartDelayMs;
        this._restartTimer = null;
        this._stopped = false;    // explicit stop(): never auto-restart
        this._detached = false;   // shutting down: never auto-restart
        this.onTunnelUp = null;   // (url) => void — set by mount(); fires on auto-restart too
        this.publicProto = publicProto;
        // Loopback bind → no LAN interface can actually reach the daemon, so
        // advertising interface IPs would hand the phone a connection-refused
        // URL. The tunnel is the only real remote door in that mode.
        this.lanReachable = !/^(127\.|localhost$|::1$)/.test(String(bindHost));
        this.state = 'idle';      // 'idle' | 'starting' | 'online' | 'error'
        this.tunnel = null;       // { url, close }
        this.publicUrl = null;
        this.error = null;
        this.startedAt = null;
        this.progress = null;     // {pct, receivedMB, totalMB} while cloudflared auto-downloads
    }

    snapshot() {
        return {
            state: this.state,
            lan:   this.lanReachable ? lanAddresses(this.port, this.publicProto) : [],
            publicUrl: this.publicUrl,
            error: this.error,
            startedAt: this.startedAt,
            progress: this.progress,
        };
    }

    async start() {
        if (this.state === 'starting' || this.state === 'online') return this.snapshot();
        this._stopped = false;
        this._clearRestart();
        this.state = 'starting';
        this.error = null;
        try {
            // On a machine with no tunnel provider, openTunnel downloads
            // cloudflared first (~20 MB). Live progress lands in the snapshot
            // so the widget's 6s status poll can narrate the one-time setup.
            this.tunnel = await this._openTunnel(this.port, p => { this.progress = p; });
            this.progress = null;
            if (!this.tunnel) {
                this.state = 'error';
                this.error = 'tunnel could not start (cloudflared download or startup failed — check network + CA certificates; details in the server log)';
                return this.snapshot();
            }
            this.publicUrl = this.tunnel.url;
            this.state = 'online';
            this.startedAt = Date.now();
            if ('onDeath' in this.tunnel) {
                this.tunnel.onDeath = () => this._onTunnelDeath();
            }
            return this.snapshot();
        } catch (err) {
            this.progress = null;
            this.state = 'error';
            this.error = err && err.message || 'tunnel failed';
            return this.snapshot();
        }
    }

    // Adopt a tunnel that survived a previous daemon process (same URL) so a
    // restart/redeploy doesn't drop the mobile bridge. Falls through to a fresh
    // start() at the call site when there's nothing healthy to adopt.
    async resume() {
        if (this.state === 'online') return this.snapshot();
        this.state = 'starting';
        this.error = null;
        try {
            const t = await this._adopt(this.port);
            if (!t) { this.state = 'idle'; return this.snapshot(); }
            this.tunnel = t;
            this.publicUrl = t.url;
            this.state = 'online';
            this.startedAt = Date.now();
            if ('onDeath' in t) t.onDeath = () => this._onTunnelDeath();
            return this.snapshot();
        } catch (err) {
            this.state = 'idle';
            this.error = null;
            return this.snapshot();
        }
    }

    // Drop our handle WITHOUT killing the tunnel, so it keeps running across a
    // graceful daemon restart and the next boot can re-adopt it. Used on
    // shutdown; contrast with stop(), which is an explicit user teardown.
    detach() {
        this._detached = true;
        this._clearRestart();
        this.tunnel = null;
        this._reset(null);
    }

    stop() {
        this._stopped = true;
        this._clearRestart();
        if (this.tunnel) {
            try { this.tunnel.close(); } catch (_) {}
        }
        this._reset(null);
        return this.snapshot();
    }

    // The tunnel process died underneath us (sleep, network loss, edge reset).
    // Until 2026-08-25 this parked the manager in `error` until a human clicked
    // START, so the phone's link stayed dead for hours. Now it re-opens the
    // tunnel by itself after a short delay. Quick tunnels can't keep their URL,
    // so onTunnelUp lets index.js re-announce and re-allow the new origin.
    _onTunnelDeath() {
        // A late exit notice for a tunnel we already stopped/detached is noise.
        if (this._stopped || this._detached) return;
        this._reset('tunnel exited — restarting');
        this._clearRestart();
        this._restartTimer = setTimeout(() => {
            this._restartTimer = null;
            this.start().then(snap => {
                if (snap.state === 'online' && snap.publicUrl) {
                    console.log(`SoA-Web tunnel:  ${snap.publicUrl}  (re-opened after the previous tunnel exited)`);
                    if (typeof this.onTunnelUp === 'function') { try { this.onTunnelUp(snap.publicUrl); } catch (_) {} }
                } else if (!this._stopped && !this._detached) {
                    // Provider still down (no network yet?) — keep trying.
                    this._onTunnelDeath();
                }
            }).catch(() => { if (!this._stopped && !this._detached) this._onTunnelDeath(); });
        }, this._restartDelayMs);
        if (this._restartTimer.unref) this._restartTimer.unref();
    }

    _clearRestart() {
        if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    }

    _reset(error) {
        this.tunnel = null;
        this.publicUrl = null;
        this.state = error ? 'error' : 'idle';
        this.error = error;
        this.startedAt = null;
        this.progress = null;
    }
}

/**
 * Server-rendered QR. Using `qrcode` keeps the client dependency-free (no
 * CDN QR lib, no base64 image) — the browser just fetches /api/pair/qr
 * and drops the SVG into the DOM.
 */
const QRCode = require('qrcode');

async function toSvg(text, { size = 220 } = {}) {
    return QRCode.toString(text, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 2,
        width: size,
        color: { dark: '#05080d', light: '#aacfd1' },
    });
}

function mount(app, requireAuthed, pair, { onTunnelUp } = {}) {
    if (onTunnelUp) pair.onTunnelUp = onTunnelUp;
    // Helper: tag the snapshot with the caller's session token so the desktop
    // can embed it as ?t= in the QR. The phone uses cookie auth via the WS
    // upgrade, but cookies don't cross devices — the token in the QR is what
    // lets the phone attach to the same session that the desktop is in.
    const withToken = (snap, req) => {
        const tok = req && req.session && req.session.token;
        return tok ? Object.assign({}, snap, { pairToken: tok }) : snap;
    };

    app.get('/api/pair/status', requireAuthed, (req, res) => {
        res.json({ ok: true, data: withToken(pair.snapshot(), req) });
    });
    app.post('/api/pair/start', requireAuthed, async (req, res) => {
        const snap = await pair.start();
        if (snap.state === 'online' && snap.publicUrl && onTunnelUp) {
            onTunnelUp(snap.publicUrl);
        }
        res.json({ ok: true, data: withToken(snap, req) });
    });
    app.post('/api/pair/stop', requireAuthed, (req, res) => {
        res.json({ ok: true, data: withToken(pair.stop(), req) });
    });
    app.get('/api/pair/qr', requireAuthed, async (req, res) => {
        const text = String((req.query && req.query.text) || '').slice(0, 2000);
        if (!text) { res.status(400).json({ ok: false, error: 'missing text' }); return; }
        try {
            const svg = await toSvg(text, { size: 220 });
            res.type('image/svg+xml').send(svg);
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
}

module.exports = { PairingManager, lanAddresses, mount, toSvg };
