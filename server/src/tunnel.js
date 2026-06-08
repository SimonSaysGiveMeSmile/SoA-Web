/**
 * Mobile Bridge — Public Tunnel
 *
 * Tries cloudflared first (free, no bandwidth limits), then ngrok,
 * then localtunnel as a last resort.
 * The tunnel is best-effort: failures here never prevent the local server from
 * starting. Callers receive { url, close() } or null.
 */

let localtunnel = null;
try {
    localtunnel = require('localtunnel');
} catch (_) {
    localtunnel = null;
}

const { execFile, spawn } = require('child_process');
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { dbg } = require('./debug');

// Where we remember a live tunnel so it can be re-adopted after a daemon
// restart instead of minting a fresh (different) URL. Keeping the same public
// URL across restarts is what stops the mobile client from losing the bridge
// when the desktop is redeployed or refreshed.
const STATE_FILE = path.join(os.homedir(), '.soa-web', 'tunnel.json');

function _saveState(state) {
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    } catch (_) { /* best-effort */ }
}
function _loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return null; }
}
function _clearState() { try { fs.unlinkSync(STATE_FILE); } catch (_) {} }

// pid liveness without sending a real signal. EPERM means it exists but is
// owned by someone else (still "alive" for our purposes).
function _alive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Probe a tunnel URL end-to-end (through Cloudflare, back to our own origin).
// 200 from /api/ping means the tunnel is alive AND routing to a live daemon.
function _probe(url) {
    return new Promise(resolve => {
        let done = false;
        const finish = v => { if (!done) { done = true; resolve(v); } };
        try {
            const u = new URL(url.replace(/\/$/, '') + '/api/ping');
            const lib = u.protocol === 'https:' ? https : http;
            const req = lib.get(u, res => {
                res.resume();
                finish(res.statusCode === 200);
            });
            req.on('error', () => finish(false));
            req.setTimeout(6000, () => { try { req.destroy(); } catch (_) {} finish(false); });
        } catch (_) { finish(false); }
    });
}

// Re-adopt a tunnel that outlived a previous daemon process. Returns a handle
// shaped like _tryCloudflared's so callers can't tell the difference, or null
// if there's nothing healthy to adopt. A process that's alive but no longer
// routing to us is killed so we don't leak orphans or run two tunnels.
async function adopt(port) {
    const st = _loadState();
    if (!st || st.provider !== 'cloudflared' || st.port !== port || !st.pid || !st.url) return null;
    if (!_alive(st.pid)) { dbg('tunnel', 'adopt: saved pid', st.pid, 'is gone'); _clearState(); return null; }
    const ok = await _probe(st.url);
    if (!ok) {
        dbg('tunnel', 'adopt: pid', st.pid, 'alive but', st.url, 'not routing — killing stale tunnel');
        try { process.kill(st.pid); } catch (_) {}
        _clearState();
        return null;
    }
    dbg('tunnel', 'adopt: re-using surviving cloudflared pid', st.pid, st.url);
    return _wrapAdopted(st);
}

function _wrapAdopted(st) {
    let dead = false;
    let onDeath = null;
    let timer = setInterval(() => {
        if (dead) return;
        if (!_alive(st.pid)) {
            dead = true;
            clearInterval(timer);
            dbg('tunnel', 'adopted cloudflared exited (tunnel down):', st.url);
            _clearState();
            if (onDeath) onDeath();
        }
    }, 10000);
    if (timer.unref) timer.unref();
    return {
        url: st.url,
        close: () => {
            dead = true;
            clearInterval(timer);
            try { process.kill(st.pid); } catch (_) {}
            _clearState();
        },
        set onDeath(fn) { onDeath = fn; },
    };
}

async function openTunnel(port) {
    dbg('tunnel', 'openTunnel: probing providers for port', port);
    const cf = await _tryCloudflared(port);
    if (cf) { dbg('tunnel', 'cloudflared up:', cf.url); return cf; }
    dbg('tunnel', 'cloudflared unavailable, trying ngrok');
    const ng = await _tryNgrok(port);
    if (ng) { dbg('tunnel', 'ngrok up:', ng.url); return ng; }
    dbg('tunnel', 'ngrok unavailable, trying localtunnel');
    const lt = await _tryLocaltunnel(port);
    if (lt) { dbg('tunnel', 'localtunnel up:', lt.url); return lt; }
    dbg('tunnel', 'no tunnel provider succeeded');
    return null;
}

// ── Cloudflare Tunnel (quick tunnel, no account needed) ───────────

async function _tryCloudflared(port) {
    const cfPath = await _findBinary('cloudflared');
    if (!cfPath) { dbg('tunnel', 'cloudflared binary not found on PATH or well-known dirs'); return null; }
    dbg('tunnel', 'cloudflared binary:', cfPath);
    try {
        // detached: run cloudflared in its own process group so it survives a
        // daemon restart (graceful exit or launchd bounce). We unref() it once
        // the URL is known and persist {pid,url} so the next boot can adopt it
        // and keep the SAME public URL — the mobile bridge never has to chase
        // a new address.
        const proc = spawn(cfPath, ['tunnel', '--url', `http://localhost:${port}`], {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
        });

        const url = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                dbg('tunnel', 'cloudflared timed out after 30s waiting for URL; last output:', buf.slice(-400));
                try { proc.kill(); } catch (_) {}
                reject(new Error('cloudflared timeout'));
            }, 30000);
            let buf = '';
            const onData = chunk => {
                buf += chunk.toString();
                const match = buf.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
                if (match) {
                    clearTimeout(timeout);
                    resolve(match[0]);
                }
            };
            proc.stdout.on('data', onData);
            proc.stderr.on('data', onData);
            proc.on('error', e => { clearTimeout(timeout); dbg('tunnel', 'cloudflared spawn error:', e.message); reject(e); });
            proc.on('exit', code => { clearTimeout(timeout); dbg('tunnel', 'cloudflared exited early, code', code, '— output:', buf.slice(-400)); reject(new Error('cloudflared exit ' + code)); });
        });

        // Remember it and let the parent exit independently of it.
        _saveState({ provider: 'cloudflared', url, pid: proc.pid, port, startedAt: Date.now() });
        try { proc.unref(); } catch (_) {}

        let dead = false;
        let onDeath = null;
        proc.on('exit', () => {
            if (dead) return;
            dead = true;
            dbg('tunnel', 'cloudflared process exited (tunnel down):', url);
            _clearState();
            if (onDeath) onDeath();
        });

        return {
            url,
            close: () => { dead = true; try { proc.kill(); } catch (_) {} _clearState(); },
            set onDeath(fn) { onDeath = fn; },
        };
    } catch (_) {
        return null;
    }
}

// ── ngrok ─────────────────────────────────────────────────────────

async function _tryNgrok(port) {
    const existing = await _checkExistingNgrok(port);
    if (existing) return existing;

    const ngrokPath = await _findBinary('ngrok');
    if (!ngrokPath) return null;
    try {
        const proc = spawn(ngrokPath, ['http', String(port), '--log=stdout', '--log-format=logfmt'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
        });

        const url = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('ngrok timeout')), 15000);
            let buf = '';
            proc.stdout.on('data', chunk => {
                buf += chunk.toString();
                const match = buf.match(/url=(https?:\/\/[^\s]+)/);
                if (match) { clearTimeout(timeout); resolve(match[1]); }
            });
            proc.on('error', e => { clearTimeout(timeout); reject(e); });
            proc.on('exit', code => { clearTimeout(timeout); reject(new Error('ngrok exit ' + code)); });
        });

        return {
            url,
            close: () => { try { proc.kill(); } catch (_) {} },
        };
    } catch (_) {
        return null;
    }
}

async function _checkExistingNgrok(port) {
    try {
        const res = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('timeout')), 3000);
            const req = http.get('http://127.0.0.1:4040/api/tunnels', r => {
                let body = '';
                r.on('data', d => body += d);
                r.on('end', () => { clearTimeout(timeout); resolve(body); });
            });
            req.on('error', e => { clearTimeout(timeout); reject(e); });
        });
        const data = JSON.parse(res);
        if (data && data.tunnels) {
            for (const t of data.tunnels) {
                const addr = t.config && t.config.addr;
                if (addr && addr.includes(':' + port) && t.public_url && t.public_url.startsWith('https://')) {
                    return { url: t.public_url, close: () => {} };
                }
            }
        }
    } catch (_) {}
    return null;
}

// ── localtunnel ───────────────────────────────────────────────────

async function _tryLocaltunnel(port) {
    if (!localtunnel) return null;
    try {
        const t = await Promise.race([
            localtunnel({ port }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
        ]);

        let dead = false;
        let onDeath = null;
        const die = () => {
            if (dead) return;
            dead = true;
            try { t.close(); } catch (_) {}
            if (onDeath) onDeath();
        };

        t.on('error', die);
        t.on('close', die);

        return {
            url: t.url,
            close: () => { dead = true; try { t.close(); } catch (_) {} },
            set onDeath(fn) { onDeath = fn; },
        };
    } catch (_) {
        return null;
    }
}

// ── helpers ───────────────────────────────────────────────────────

function _findBinary(name) {
    // Probe well-known install locations first so the lookup works even when
    // the parent process's PATH is stripped (launchd, IDE shells, etc.).
    const candidates = [
        '/opt/homebrew/bin/' + name,
        '/usr/local/bin/' + name,
        '/usr/bin/' + name,
        '/bin/' + name,
    ];
    for (const c of candidates) {
        try { if (fs.existsSync(c)) return Promise.resolve(c); } catch (_) {}
    }
    return new Promise(resolve => {
        execFile('which', [name], (err, stdout) => {
            if (err || !stdout.trim()) return resolve(null);
            resolve(stdout.trim());
        });
    });
}

module.exports = { openTunnel, adopt, available: !!localtunnel };
