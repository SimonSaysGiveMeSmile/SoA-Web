/**
 * localHost — the browser-facing half of the "is this caller on this machine?"
 * test (see sessionManager.isLocalRequest).
 *
 * A loopback socket with no forwarding header is not enough on its own: a page
 * on attacker.example can DNS-rebind its name to 127.0.0.1, and the user's OWN
 * browser then sends loopback requests to the daemon with
 * `Host: attacker.example:4010`. Those carry no proxy header, so they would pass
 * as local, skip pairing, and drive /api/tabs or read files through /preview.
 *
 * Two things a page cannot forge close that:
 *   - Host: the browser always sends the name it resolved. Only a loopback name
 *     (127.0.0.1, localhost, [::1]) means the page itself is on this machine.
 *   - Origin: when present it names the page that made the request. A plain
 *     cross-site request to http://127.0.0.1:4010 (no rebinding needed) keeps a
 *     loopback Host but carries the attacker's Origin.
 * The per-daemon local key (x-soa-local-key) is checked before either, so the
 * CLIs and hooks keep working whatever Host they send.
 */

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);

// Host header (or URL host) → is it a loopback name? Any port, or none.
// Accepts `127.0.0.1`, `localhost:4010`, `[::1]:4010` and a bare `::1`.
function isLoopbackHost(host) {
    if (!host || typeof host !== 'string') return false;
    let h = host.trim().toLowerCase();
    if (h === '::1') return true;
    if (h.startsWith('[')) {
        const end = h.indexOf(']');
        if (end < 0) return false;
        const rest = h.slice(end + 1);
        if (rest && !/^:\d{1,5}$/.test(rest)) return false;
        h = h.slice(1, end);
    } else {
        const m = /^([^:]+)(?::\d{1,5})?$/.exec(h);
        if (!m) return false;
        h = m[1];
    }
    return LOOPBACK_NAMES.has(h);
}

// The daemon's CORS allowlist (index.js ALLOWED_ORIGINS — the deployed front
// end, the native app shells, the tunnel once it is up). Held by reference so
// origins pushed onto it later are seen. Unset → only loopback origins pass.
let _trustedOrigins = null;
function setTrustedOrigins(list) { _trustedOrigins = list; }

// No Origin (curl, the CLIs, a same-origin GET) is fine — the Host check above
// still applies. `null` (sandboxed frame, file://) is never trusted.
function isTrustedOrigin(origin) {
    if (origin == null || origin === '') return true;
    if (typeof origin !== 'string' || origin === 'null') return false;
    try {
        const u = new URL(origin);
        if ((u.protocol === 'http:' || u.protocol === 'https:') && isLoopbackHost(u.host)) return true;
    } catch (_) { return false; }
    const list = typeof _trustedOrigins === 'function' ? _trustedOrigins() : _trustedOrigins;
    return Array.isArray(list) && list.includes(origin);
}

module.exports = { isLoopbackHost, isTrustedOrigin, setTrustedOrigins };
