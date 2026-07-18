/**
 * shareRegistry — capability tokens for per-tab share links.
 *
 * A share is a revocable, expiring capability bound to ONE (sessionId, tabId).
 * Possessing the token authorizes a read-only viewer of exactly that tab's PTY
 * output — nothing else (no other tab, no /api, no manager, no input). The
 * token is the secret; the shareId is the public handle used to revoke.
 *
 * In-memory only (POC). Shares evaporate on daemon restart — fine for a
 * "share this while I work" flow; persistence can be added later without
 * touching callers.
 */

const crypto = require('crypto');

const shares = new Map(); // shareId -> record
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function create({ sessionId, tabId, mode = 'read', ttlMs = DEFAULT_TTL_MS }) {
    const shareId = crypto.randomBytes(6).toString('hex');
    const token = crypto.randomBytes(24).toString('base64url');
    const rec = {
        shareId, token,
        sessionId,
        tabId: Number(tabId),
        mode: mode === 'interactive' ? 'interactive' : 'read', // POC: only 'read' is honored downstream
        createdAt: Date.now(),
        expiresAt: Date.now() + Math.max(60_000, ttlMs),
        revoked: false,
    };
    shares.set(shareId, rec);
    return rec;
}

// Validate a presented (shareId, token). Returns the record or null. Constant-
// time token compare; rejects revoked/expired/unknown.
function resolve(shareId, token) {
    if (!shareId || !token) return null;
    const rec = shares.get(String(shareId));
    if (!rec || rec.revoked) return null;
    if (rec.expiresAt && Date.now() > rec.expiresAt) { shares.delete(rec.shareId); return null; }
    const a = Buffer.from(String(token));
    const b = Buffer.from(rec.token);
    if (a.length !== b.length) return null;
    try { if (!crypto.timingSafeEqual(a, b)) return null; } catch (_) { return null; }
    return rec;
}

function revoke(shareId) {
    const rec = shares.get(String(shareId));
    if (!rec) return false;
    rec.revoked = true;
    shares.delete(rec.shareId);
    return true;
}

function listFor(sessionId) {
    const now = Date.now();
    return [...shares.values()].filter(r => r.sessionId === sessionId && !r.revoked && now < r.expiresAt);
}

// Non-secret metadata lookup (no token) — for ownership checks + the live sweep.
function getMeta(shareId) {
    const r = shares.get(String(shareId));
    if (!r) return null;
    return { shareId: r.shareId, sessionId: r.sessionId, tabId: r.tabId, mode: r.mode, revoked: r.revoked, expiresAt: r.expiresAt };
}

// Is this share still valid (exists, not revoked, not expired)? Used by the
// server-side sweep to cut LIVE viewer sockets on revoke/expiry.
function isLive(shareId) {
    const r = shares.get(String(shareId));
    return !!(r && !r.revoked && Date.now() < r.expiresAt);
}

module.exports = { create, resolve, revoke, listFor, getMeta, isLive };
