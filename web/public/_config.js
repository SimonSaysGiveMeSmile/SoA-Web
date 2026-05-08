/**
 * Runtime client config — placeholder.
 *
 * When self-hosted, the Node server overwrites this at request time (see
 * `app.get('/_config.js')` in server/src/index.js) with the real auth mode.
 *
 * When deployed on Vercel as a static SPA, scripts/vercel-build.js rewrites
 * this file at build time with the contents of SOA_WEB_BACKEND and
 * SOA_WEB_AUTH from the project's environment.
 *
 * `backend` empty → API + WS calls target the current origin. Non-empty →
 * calls target that origin instead (e.g. a Cloudflare Tunnel URL).
 */
window.__SOA_WEB__ = {
    auth: 'shared',
    protocol: 1,
    backend: ''
};
