'use strict';

/**
 * tunnelGate — QR-holder-only access decisions for the public tunnel.
 *
 * SoA has no login: on the local machine every request auto-provisions a
 * session (that's fine — it's your own box). But the same daemon is reachable
 * over the Cloudflare tunnel, and there the auto-provision turned the tunnel
 * into an *open, unauthenticated shell* for anyone who discovered the URL.
 *
 * The fix: a request that arrives over the tunnel (i.e. NOT local — decided by
 * sessionManager.isLocalRequest, which is spoof-safe: a tunnel client can't
 * strip cloudflare's forwarding headers, and a local client that fakes them
 * only restricts itself) must present the per-session *pairing token* — the
 * 256-bit token embedded in the QR that the phone already sends on every /ws
 * and /api call. Possessing the token == authorized for that session (a
 * capability), so pairing stays one-scan and needs zero client changes.
 *
 * These helpers are pure so the security-critical branching is unit-testable
 * without booting the server. `openTunnel` is the SOA_WEB_OPEN_TUNNEL=1 escape
 * hatch (restore the old open behavior); `sessionTokenMode` is selfhost's
 * global-token mode, which already gates every request upstream.
 */

// HTTP: may a session-less request auto-provision a fresh session? Only local
// callers (your own machine) or the explicit escape hatches. A remote caller
// must have already resolved a session via a valid pairing token upstream.
function httpMayProvision({ isLocal, openTunnel, sessionTokenMode }) {
    return !!(isLocal || openTunnel || sessionTokenMode);
}

// WS: decide how to bind an upgrade. Priority: an explicit pairing token wins
// (the phone that scanned the QR); then a cookie session that already owns
// tabs; then — only for trusted callers — the primary-share / new-session
// fallback the local desktop relies on. A remote caller with none of those is
// an anonymous tunnel visitor → reject (no primary-share to strangers).
function decideWsBind({ tokenSession, existingHasTabs, isLocal, openTunnel, sessionTokenMode }) {
    if (tokenSession)   return { action: 'bind', source: 'token',  via: 'pair-token' };
    if (existingHasTabs) return { action: 'bind', source: 'cookie', via: 'cookie' };
    if (isLocal || openTunnel || sessionTokenMode) {
        return { action: 'bind', source: 'primary-or-new', via: 'primary-share' };
    }
    return { action: 'reject', via: 'remote-no-token' };
}

module.exports = { httpMayProvision, decideWsBind };
