/**
 * localKey — a per-daemon secret that proves a request came from a process THIS
 * daemon spawned (a local tab), not from the public tunnel.
 *
 * The loopback gate on /api/sessions + /api/tts can't trust the socket IP alone:
 * the tunnel (cloudflared) dials 127.0.0.1, so an internet caller re-originates
 * from loopback. A header denylist (cf-connecting-ip / x-forwarded-for / …) closes
 * the known providers but is a denylist — fragile to a new proxy header, and it
 * false-rejects a genuinely-local caller behind a local reverse proxy.
 *
 * This secret is POSITIVE proof: it's injected into every spawned tab's env
 * (SOA_WEB_LOCAL_KEY, see tts.envFor) and echoed by the local CLIs (soa-sessions /
 * soa-msg) as the x-soa-local-key header. Only a process the daemon spawned can
 * know it; a remote tunneled request cannot. Persisted (0600) per state dir so it
 * stays stable across daemon restarts — a long-lived tab's injected key keeps
 * working after a restart. The header denylist remains as a fallback for keyless
 * callers (manual curl), so this layer is purely additive.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { STATE_DIR } = require('./stateDir');

const KEY_FILE = path.join(STATE_DIR, '.local-key');

function loadOrCreate() {
    try {
        const k = fs.readFileSync(KEY_FILE, 'utf8').trim();
        if (k && k.length >= 32) return k;
    } catch (_) { /* absent → mint below */ }
    const k = crypto.randomBytes(32).toString('hex');
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.writeFileSync(KEY_FILE, k, { mode: 0o600 });
    } catch (_) { /* read-only fs: key still usable in-process this boot */ }
    return k;
}

const LOCAL_KEY = loadOrCreate();

// Constant-time compare so the gate leaks no timing signal about the secret.
function matches(presented) {
    if (!presented || typeof presented !== 'string') return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(LOCAL_KEY);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { LOCAL_KEY, matches };
