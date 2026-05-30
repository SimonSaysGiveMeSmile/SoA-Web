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
const fs = require('fs');
const path = require('path');
const { dbg } = require('./debug');

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
        const proc = spawn(cfPath, ['tunnel', '--url', `http://localhost:${port}`], {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
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

        let dead = false;
        let onDeath = null;
        proc.on('exit', () => {
            if (dead) return;
            dead = true;
            dbg('tunnel', 'cloudflared process exited (tunnel down):', url);
            if (onDeath) onDeath();
        });

        return {
            url,
            close: () => { dead = true; try { proc.kill(); } catch (_) {} },
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

module.exports = { openTunnel, available: !!localtunnel };
