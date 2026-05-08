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
const { openTunnel } = require('./tunnel');

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
    constructor({ port, publicProto = 'http' }) {
        this.port = port;
        this.publicProto = publicProto;
        this.state = 'idle';      // 'idle' | 'starting' | 'online' | 'error'
        this.tunnel = null;       // { url, close }
        this.publicUrl = null;
        this.error = null;
        this.startedAt = null;
    }

    snapshot() {
        return {
            state: this.state,
            lan:   lanAddresses(this.port, this.publicProto),
            publicUrl: this.publicUrl,
            error: this.error,
            startedAt: this.startedAt,
        };
    }

    async start() {
        if (this.state === 'starting' || this.state === 'online') return this.snapshot();
        this.state = 'starting';
        this.error = null;
        try {
            this.tunnel = await openTunnel(this.port);
            if (!this.tunnel) {
                this.state = 'error';
                this.error = 'no tunnel provider available (install cloudflared or ngrok, or npm i localtunnel)';
                return this.snapshot();
            }
            this.publicUrl = this.tunnel.url;
            this.state = 'online';
            this.startedAt = Date.now();
            if ('onDeath' in this.tunnel) {
                this.tunnel.onDeath = () => this._reset('tunnel exited');
            }
            return this.snapshot();
        } catch (err) {
            this.state = 'error';
            this.error = err && err.message || 'tunnel failed';
            return this.snapshot();
        }
    }

    stop() {
        if (this.tunnel) {
            try { this.tunnel.close(); } catch (_) {}
        }
        this._reset(null);
        return this.snapshot();
    }

    _reset(error) {
        this.tunnel = null;
        this.publicUrl = null;
        this.state = error ? 'error' : 'idle';
        this.error = error;
        this.startedAt = null;
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

function mount(app, requireAuthed, pair) {
    app.get('/api/pair/status', requireAuthed, (req, res) => {
        res.json({ ok: true, data: pair.snapshot() });
    });
    app.post('/api/pair/start', requireAuthed, async (req, res) => {
        const snap = await pair.start();
        res.json({ ok: true, data: snap });
    });
    app.post('/api/pair/stop', requireAuthed, (req, res) => {
        res.json({ ok: true, data: pair.stop() });
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
