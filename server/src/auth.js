/**
 * Auth
 *
 * Running a web terminal publicly with no auth hands the internet a shell.
 * Three modes, picked by `SOA_WEB_AUTH`:
 *
 *   - `open`    — no auth. Only valid when explicitly set AND the server is
 *                 bound to 127.0.0.1 (enforced at boot). Local dev only.
 *   - `shared`  — single shared secret in `SOA_WEB_PASSWORD`. Users POST it
 *                 to /login and get a signed cookie. Default when a password
 *                 is configured.
 *   - `none`    — same as `open` but allowed on any host. Use if an upstream
 *                 proxy (Cloudflare Access, Tailscale Funnel, an oauth2_proxy)
 *                 already handles auth.
 *
 * The server refuses to start in `open` mode on non-loopback hosts unless the
 * operator sets `SOA_WEB_AUTH=none` on purpose.
 */

const crypto = require('crypto');

const COOKIE_NAME = 'soa_web_auth';
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 7;  // 7 days

function resolveMode(env = process.env) {
    const raw = (env.SOA_WEB_AUTH || '').toLowerCase();
    if (raw === 'open' || raw === 'shared' || raw === 'none') return raw;
    if (env.SOA_WEB_PASSWORD) return 'shared';
    return 'open';
}

function resolvePassword(env = process.env) {
    return env.SOA_WEB_PASSWORD || '';
}

function resolveSignKey(env = process.env) {
    const k = env.SOA_WEB_SIGN_KEY;
    if (k && k.length >= 16) return k;
    // Ephemeral key: cookies survive only as long as the process does. Fine for
    // dev; ops should set SOA_WEB_SIGN_KEY in production so restarts don't log
    // users out.
    return crypto.randomBytes(32).toString('hex');
}

function sign(value, key) {
    const mac = crypto.createHmac('sha256', key).update(value).digest('base64url');
    return `${value}.${mac}`;
}

function verify(signed, key) {
    if (!signed || typeof signed !== 'string') return null;
    const dot = signed.lastIndexOf('.');
    if (dot <= 0) return null;
    const value = signed.slice(0, dot);
    const mac   = signed.slice(dot + 1);
    const expected = crypto.createHmac('sha256', key).update(value).digest('base64url');
    if (mac.length !== expected.length) return null;
    try {
        if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    } catch (_) { return null; }
    return value;
}

function issue(subject, key) {
    const payload = JSON.stringify({ sub: subject, iat: Date.now() });
    return sign(Buffer.from(payload).toString('base64url'), key);
}

function readCookie(header, name) {
    if (!header) return null;
    const parts = header.split(/;\s*/);
    for (const p of parts) {
        const eq = p.indexOf('=');
        if (eq === -1) continue;
        if (p.slice(0, eq) === name) return decodeURIComponent(p.slice(eq + 1));
    }
    return null;
}

function makeCookie(value, { secure, crossSite }) {
    // When the SPA is served from a different origin (e.g. Vercel fronting a
    // Cloudflare-tunneled backend), the cookie has to travel on cross-site
    // requests. Browsers require SameSite=None cookies to be marked Secure,
    // which is fine — cross-site auth only makes sense over HTTPS anyway.
    const sameSite = crossSite ? 'None' : 'Lax';
    const attrs = [
        `${COOKIE_NAME}=${encodeURIComponent(value)}`,
        'Path=/',
        'HttpOnly',
        `SameSite=${sameSite}`,
        `Max-Age=${COOKIE_MAX_AGE_SEC}`,
    ];
    if (secure || crossSite) attrs.push('Secure');
    return attrs.join('; ');
}

function clearCookie({ secure, crossSite }) {
    const sameSite = crossSite ? 'None' : 'Lax';
    const attrs = [
        `${COOKIE_NAME}=`,
        'Path=/',
        'HttpOnly',
        `SameSite=${sameSite}`,
        'Max-Age=0',
    ];
    if (secure || crossSite) attrs.push('Secure');
    return attrs.join('; ');
}

function constantTimeEq(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch (_) { return false; }
}

module.exports = {
    COOKIE_NAME,
    resolveMode, resolvePassword, resolveSignKey,
    sign, verify, issue,
    readCookie, makeCookie, clearCookie,
    constantTimeEq,
};
