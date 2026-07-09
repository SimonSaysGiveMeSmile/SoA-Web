'use strict';
//
// entitlements.js — the single source of truth for premium-feature gating.
//
// The fleet MANAGER (fleet oversight: /api/manager*, /api/sessions, the
// always-on supervisor, the dashboard DASH view, soa-sessions, the
// manager-watchdog) is a paid feature. Everything that decides "is this feature
// available?" goes through THIS module so there is exactly one seam to change.
//
// ── v1 (today): PER-INSTALL ──────────────────────────────────────────────────
//   There are no user accounts yet — every SoA session is anonymous and each
//   customer runs their own daemon. So entitlement is per-INSTALL: the manager
//   unlocks via an env flag (SOA_WEB_MANAGER_ENABLED=1) or a license file in the
//   state dir (~/.soa-web-local/license.json). Free installs default OFF.
//
// ── SOON (accounts + billing): PER-USER ──────────────────────────────────────
//   Auth + pay are coming. This module is shaped so that upgrade is a drop-in:
//   every check takes a context `ctx = { req, user }`. When accounts land,
//   (1) fill in getUserContext(req) to return the authenticated user + plan, and
//   (2) extend resolve() to honor ctx.user.plan / a Stripe entitlement.
//   The chokepoints, the /api/capabilities endpoint, and the client do NOT
//   change — only the two clearly-marked TODO(accounts) spots below.
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Features the product can gate. Keep the keys stable — clients and the CLI
// reference them by name.
const FEATURES = {
    manager: {
        env: 'SOA_WEB_MANAGER_ENABLED',   // per-install override (1/0)
        label: 'Fleet Manager',
    },
};

function stateDir() {
    return process.env.SOA_WEB_STATE_DIR || path.join(os.homedir(), '.soa-web');
}
function licensePath() {
    return process.env.SOA_WEB_LICENSE_FILE || path.join(stateDir(), 'license.json');
}

// ── Env override ─────────────────────────────────────────────────────────────
// Truthy/falsey parse for the per-install flag. Returns true|false|null
// (null = "not set", fall through to the license file).
function envFlag(name) {
    const v = process.env[name];
    if (v == null || v === '') return null;
    if (/^(1|true|on|yes)$/i.test(v)) return true;
    if (/^(0|false|off|no)$/i.test(v)) return false;
    return null;
}

// ── License file ─────────────────────────────────────────────────────────────
// Shape (see scripts/soa-license):
//   { "features": ["manager"], "plan": "pro", "issuedTo": "...",
//     "issuedAt": "ISO", "expiresAt": "ISO"|null, "sig": "<hmac-hex>" }
// Signature: HMAC-SHA256 over the canonical payload (all keys except `sig`,
// sorted, compact JSON) using SOA_WEB_LICENSE_SECRET. Verified ONLY when that
// secret is configured — so a fresh owner install works out of the box, and a
// vendor who sets the secret gets tamper-evident, forgery-resistant licenses.
let _licCache = null;      // { mtimeMs, parsed }  — cheap re-read guard
let _unsignedWarned = false;

function canonicalPayload(obj) {
    const { sig, ...rest } = obj; // eslint-disable-line no-unused-vars
    const sorted = {};
    for (const k of Object.keys(rest).sort()) sorted[k] = rest[k];
    return JSON.stringify(sorted);
}
function expectedSig(obj, secret) {
    return crypto.createHmac('sha256', secret).update(canonicalPayload(obj)).digest('hex');
}

// Returns { valid, features:Set, plan, expiresAt, reason }.
function loadLicense() {
    const file = licensePath();
    let stat;
    try { stat = fs.statSync(file); } catch (_) { return { valid: false, reason: 'no-license' }; }
    if (_licCache && _licCache.mtimeMs === stat.mtimeMs) return _licCache.parsed;

    let parsed;
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        parsed = validateLicense(raw);
    } catch (e) {
        parsed = { valid: false, reason: 'unreadable: ' + (e && e.message) };
    }
    _licCache = { mtimeMs: stat.mtimeMs, parsed };
    return parsed;
}

function validateLicense(raw) {
    if (!raw || typeof raw !== 'object') return { valid: false, reason: 'not-an-object' };
    const features = new Set(
        Array.isArray(raw.features) ? raw.features
            : (raw.feature ? [raw.feature] : [])
    );
    if (raw.enabled === false) return { valid: false, reason: 'disabled' };

    // Expiry.
    let expiresAt = null;
    if (raw.expiresAt) {
        const t = Date.parse(raw.expiresAt);
        if (!Number.isNaN(t)) {
            expiresAt = t;
            if (t < Date.now()) return { valid: false, reason: 'expired', expiresAt };
        }
    }

    // Signature — enforced only when a secret is configured.
    const secret = process.env.SOA_WEB_LICENSE_SECRET;
    if (secret) {
        if (!raw.sig) return { valid: false, reason: 'unsigned (secret is set — license must be signed)' };
        const want = expectedSig(raw, secret);
        // timing-safe compare
        const a = Buffer.from(String(raw.sig)); const b = Buffer.from(want);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            return { valid: false, reason: 'bad-signature' };
        }
    } else if (!_unsignedWarned) {
        _unsignedWarned = true;
        console.log('entitlements: accepting license.json WITHOUT signature verification '
            + '(SOA_WEB_LICENSE_SECRET not set) — fine for a single owner install; '
            + 'set the secret to harden distributed licenses.');
    }

    return { valid: features.size > 0, features, plan: raw.plan || null, expiresAt,
        issuedTo: raw.issuedTo || null, reason: 'ok' };
}

// ── The resolver ─────────────────────────────────────────────────────────────
// Returns { enabled, source, plan, expiresAt }. `source` is for diagnostics:
// 'env' | 'user-plan' | 'license' | 'default'.
function resolve(feature, ctx = {}) {
    const spec = FEATURES[feature];
    if (!spec) return { enabled: false, source: 'unknown-feature' };

    // 1) Per-install env override — also the owner's / dev lever, and wins.
    const all = envFlag('SOA_WEB_ALL_FEATURES');
    if (all != null) return { enabled: all, source: 'env(all)' };
    const flag = envFlag(spec.env);
    if (flag != null) return { enabled: flag, source: 'env' };

    // 2) TODO(accounts): per-USER plan. When auth lands, ctx.user is populated
    //    by getUserContext(req); honor a subscription/plan here, e.g.:
    //      if (ctx.user && ctx.user.entitlements?.has(feature)) return {enabled:true, source:'user-plan', plan:ctx.user.plan};
    //    Left inert today (ctx.user is always the anonymous owner).
    if (ctx.user && ctx.user.entitlements && ctx.user.entitlements.has &&
        ctx.user.entitlements.has(feature)) {
        return { enabled: true, source: 'user-plan', plan: ctx.user.plan || null };
    }

    // 3) Per-install license file.
    const lic = loadLicense();
    if (lic.valid && lic.features && lic.features.has(feature)) {
        return { enabled: true, source: 'license', plan: lic.plan, expiresAt: lic.expiresAt };
    }

    // 4) Default: locked.
    return { enabled: false, source: 'default' };
}

function isEnabled(feature, ctx) { return resolve(feature, ctx).enabled === true; }

// ── User context (the accounts seam) ─────────────────────────────────────────
// TODO(accounts): return the authenticated user for `req` — { id, plan,
// entitlements:Set<feature> } — from the session/JWT once login exists. Today
// there are no accounts, so every request is the single anonymous owner and
// entitlement is decided per-install (env/license), not per-user.
function getUserContext(req) {
    return { id: 'owner', authenticated: false, plan: null, entitlements: null };
}

// What the client is allowed to show. Per-context so it becomes per-user for
// free once accounts exist — the client keeps calling /api/capabilities.
function capabilities(ctx = {}) {
    const caps = {};
    for (const name of Object.keys(FEATURES)) caps[name] = isEnabled(name, ctx);
    return caps;
}

// ── Express middleware ───────────────────────────────────────────────────────
// Gate a route on a feature. 403 + a stable machine code the CLI/client key off.
function requireEntitled(feature) {
    return function (req, res, next) {
        const ctx = { req, user: getUserContext(req) };
        if (isEnabled(feature, ctx)) return next();
        res.status(403).json({
            ok: false,
            error: `${(FEATURES[feature] && FEATURES[feature].label) || feature} is not enabled for this install`,
            code: 'FEATURE_NOT_ENTITLED',
            feature,
        });
    };
}

// Test/ops hook: drop the license cache (e.g. after writing a new license).
function reload() { _licCache = null; _unsignedWarned = false; }

module.exports = {
    FEATURES, resolve, isEnabled, capabilities, requireEntitled,
    getUserContext, loadLicense, reload,
    // exported for the soa-license tool + tests:
    canonicalPayload, expectedSig,
};
