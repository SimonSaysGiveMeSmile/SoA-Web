/**
 * Runtime client config — placeholder.
 *
 * `mode`:
 *   'server'       — classic mode: talk to a Node server over WebSocket (the
 *                    self-hosted default; also what scripts/vercel-build.js
 *                    emits when SOA_WEB_MODE is not set).
 *   'webcontainer' — serverless mode: boot an in-browser Node sandbox via
 *                    WebContainers and stream its PTY into xterm. No backend
 *                    process required. Set SOA_WEB_MODE=webcontainer in the
 *                    Vercel project env to ship this build.
 *
 * `backend` — only used in server mode. Empty → same-origin. Non-empty → that
 *             origin (e.g. a Cloudflare Tunnel URL).
 *
 * `wcClientId` — WebContainers API key, required on non-stackblitz.io /
 *                non-localhost origins. Get one free at webcontainers.io and
 *                set SOA_WEB_WC_CLIENT_ID in Vercel env.
 */
window.__SOA_WEB__ = {
    mode: 'server',
    protocol: 1,
    backend: '',
    wcClientId: '',
    releaseUrl: 'https://github.com/SimonSaysGiveMeSmile/SoA-Web/releases'
};
