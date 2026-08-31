/**
 * Auth
 *
 * There is no login. This module only provides the HMAC-signed session cookie
 * plumbing used by index.js to keep each browser pinned to the same Session
 * across reloads. No passwords, no modes.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const COOKIE_NAME = 'soa_web_auth';
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 7;  // 7 days
// Re-issue a cookie once it is this old. Without a sliding window an active
// browser crosses the hard Max-Age mid-session: its next request mints a NEW,
// empty session, and the WS bind that follows can rehydrate the saved fleet on
// top of the one still running (2026-08-25: 7-day cookie lapsed at 17:31, the
// phone bound to the fresh empty session at 21:10, every agent got doubled).
const COOKIE_RENEW_AFTER_MS = 60 * 60 * 24 * 1000;

const SIGN_KEY_FILE = require('./stateDir').stateFile('sign-key');

function resolveSignKey(env = process.env) {
    const k = env.SOA_WEB_SIGN_KEY;
    if (k && k.length >= 16) return k;
    try {
        const onDisk = fs.readFileSync(SIGN_KEY_FILE, 'utf8').trim();
        if (onDisk.length >= 16) return onDisk;
    } catch (_) { /* not yet written */ }
    const fresh = crypto.randomBytes(32).toString('hex');
    try {
        fs.mkdirSync(path.dirname(SIGN_KEY_FILE), { recursive: true });
        fs.writeFileSync(SIGN_KEY_FILE, fresh, { mode: 0o600 });
    } catch (_) { /* fall back to ephemeral */ }
    return fresh;
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

// iat (ms) baked into a signed cookie, or null when it doesn't verify.
function issuedAt(signedCookie, key) {
    const decoded = verify(signedCookie, key);
    if (!decoded) return null;
    try {
        const iat = JSON.parse(Buffer.from(decoded, 'base64url').toString('utf8')).iat;
        return Number.isFinite(iat) ? iat : null;
    } catch (_) { return null; }
}

function shouldRenew(iatMs, nowMs = Date.now()) {
    if (!Number.isFinite(iatMs)) return true;
    return nowMs - iatMs >= COOKIE_RENEW_AFTER_MS;
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
    issuedAt, shouldRenew, COOKIE_RENEW_AFTER_MS,
    COOKIE_NAME,
    resolveSignKey,
    sign, verify, issue,
    readCookie, makeCookie, clearCookie,
};
