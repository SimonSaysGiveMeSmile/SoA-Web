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

const { execFile, execFileSync, spawn } = require('child_process');
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { dbg } = require('./debug');
const { ensureCloudflared } = require('./tunnelProvision');

// Where we remember a live tunnel so it can be re-adopted after a daemon
// restart instead of minting a fresh (different) URL. Keeping the same public
// URL across restarts is what stops the mobile client from losing the bridge
// when the desktop is redeployed or refreshed.
const STATE_FILE = require('./stateDir').stateFile('tunnel.json');

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

// DoH (DNS-over-HTTPS, port 443) resolve — unaffected by a flaky local UDP/53
// resolver. Lets _probe reach a tunnel that's genuinely alive even when
// getaddrinfo NXDOMAINs its fresh *.trycloudflare.com host. First A, or null.
function _dohResolve4(host) {
    return new Promise(resolve => {
        const req = https.get(`https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=A`,
            { headers: { accept: 'application/dns-json' } }, res => {
                let s = ''; res.on('data', d => s += d);
                res.on('end', () => { try { const a = (JSON.parse(s).Answer || []).find(x => x.type === 1); resolve(a ? a.data : null); } catch (_) { resolve(null); } });
            });
        req.on('error', () => resolve(null));
        req.setTimeout(5000, () => { try { req.destroy(); } catch (_) {} resolve(null); });
    });
}

// One GET to url/api/ping. opts.ip pins a resolved IP via a custom lookup (the
// real hostname is still used for SNI/Host). Resolves { ok, dnsErr }.
function _probeOnce(url, ip) {
    return new Promise(resolve => {
        let done = false;
        const finish = (ok, dnsErr) => { if (!done) { done = true; resolve({ ok, dnsErr: !!dnsErr }); } };
        try {
            const u = new URL(url.replace(/\/$/, '') + '/api/ping');
            const lib = u.protocol === 'https:' ? https : http;
            const opts = ip ? { lookup: (h, o, cb) => { if (typeof o === 'function') cb = o; cb(null, ip, 4); } } : {};
            const req = lib.get(u, opts, res => { res.resume(); finish(res.statusCode === 200, false); });
            req.on('error', e => finish(false, e && /ENOTFOUND|EAI_AGAIN|ENODATA/.test(e.code || '')));
            req.setTimeout(6000, () => { try { req.destroy(); } catch (_) {} finish(false, false); });
        } catch (_) { finish(false, false); }
    });
}

// Probe a tunnel URL end-to-end (through Cloudflare, back to our own origin).
// 200 from /api/ping means the tunnel is alive AND routing to a live daemon.
// CRITICAL for restart survival: if the local resolver can't resolve the host
// (NXDOMAIN on a flaky network), retry via a DoH-pinned IP rather than declaring
// the tunnel dead — otherwise adopt() kills a healthy surviving tunnel on every
// daemon restart and mints a NEW url, breaking remote clients' saved link.
async function _probe(url) {
    const first = await _probeOnce(url, null);
    if (first.ok) return true;
    if (!first.dnsErr) return false;
    let host; try { host = new URL(url).hostname; } catch (_) { return false; }
    const ip = await _dohResolve4(host);
    if (!ip) return false;
    dbg('tunnel', 'probe: local resolver failed for', host, '— retrying via DoH-pinned', ip);
    return (await _probeOnce(url, ip)).ok;
}

// Find the surviving cloudflared quick-tunnel for this port by its command line.
// Needed because the channel self-healer (soa-channels) rewrites tunnel.json
// WITHOUT the pid (provider:"cloudflare"), so the saved pid is often absent —
// but the detached cloudflared is still running and adoptable.
function _findCloudflaredPid(port) {
    try {
        const out = execFileSync('pgrep', ['-f', `cloudflared tunnel --url http://localhost:${port}`], { encoding: 'utf8', timeout: 3000 });
        const pid = parseInt((out || '').split('\n').filter(Boolean)[0], 10);
        return Number.isInteger(pid) ? pid : null;
    } catch (_) { return null; }
}

// Re-adopt a tunnel that outlived a previous daemon process (same URL), so a
// restart/redeploy never breaks remote/mobile clients. Accepts both the
// tunnel.js-written state (provider:"cloudflared" + pid) AND the self-healer's
// (provider:"cloudflare", no pid) — in the latter case it finds the surviving
// process by port. Returns a handle shaped like _tryCloudflared's, or null.
async function adopt(port) {
    const st = _loadState();
    if (!st || !st.url || st.port !== port || !/^cloudflared?$/.test(st.provider || '')) return null;
    let pid = (st.pid && _alive(st.pid)) ? st.pid : null;
    const fromSaved = pid !== null;
    if (!pid) pid = _findCloudflaredPid(port);   // healer-rewritten tunnel.json: no pid → find the survivor
    if (!pid || !_alive(pid)) { dbg('tunnel', 'adopt: no live cloudflared survivor for', st.url); return null; }
    const ok = await _probe(st.url);             // DoH-aware: a flaky local resolver won't false-kill a live tunnel
    if (!ok) {
        dbg('tunnel', 'adopt: pid', pid, st.url, 'not routing');
        // Only reap a process WE recorded — never a pgrep-discovered one (could be
        // a healthy tunnel the local probe simply couldn't resolve).
        if (fromSaved) { try { process.kill(pid); } catch (_) {} _clearState(); }
        return null;
    }
    dbg('tunnel', 'adopt: re-using surviving cloudflared pid', pid, st.url);
    return _wrapAdopted({ ...st, pid, provider: 'cloudflared' });
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

// onProgress (optional) receives {pct, receivedMB, totalMB} while cloudflared
// is being auto-downloaded on a machine that has none (see tunnelProvision).
async function openTunnel(port, onProgress) {
    dbg('tunnel', 'openTunnel: probing providers for port', port);
    const cf = await _tryCloudflared(port, onProgress);
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

async function _tryCloudflared(port, onProgress) {
    // Finds a system cloudflared, or downloads the official release into the
    // state dir when the machine has none — a fresh install pairs a phone
    // with one click, no brew/account/terminal (see tunnelProvision.js).
    const cfPath = await ensureCloudflared(onProgress);
    // Download done (or skipped) — clear the progress note so the UI shows a
    // plain STARTING while the tunnel itself spawns, not a stuck "99%".
    if (onProgress) { try { onProgress(null); } catch (_) {} }
    if (!cfPath) { dbg('tunnel', 'cloudflared unavailable (not found and auto-download failed/disabled)'); return null; }
    dbg('tunnel', 'cloudflared binary:', cfPath);
    try {
        // detached: run cloudflared in its own process group so it survives a
        // daemon restart (graceful exit or launchd bounce). We unref() it once
        // the URL is known and persist {pid,url} so the next boot can adopt it
        // and keep the SAME public URL — the mobile bridge never has to chase
        // a new address.
        // --no-autoupdate LAST so the argv prefix stays pgrep-matchable by
        // _findCloudflaredPid. Without it a standalone binary self-updates
        // (~24h) and re-execs, minting a NEW trycloudflare URL out from under
        // the paired phone and defeating adopt()'s same-URL restart survival.
        const proc = spawn(cfPath, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
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
