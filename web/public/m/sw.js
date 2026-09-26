/**
 * Minimal service worker for the mobile companion PWA.
 *
 * Strategy: "shell-cache, network-first for HTML, cache-first for static
 * assets". The actual session data flows over WebSocket, never HTTP, so this
 * SW is purely about making the app installable and fast to launch.
 */

// Scope-relative shell cache supports both standalone / and hosted /m/ apps.
const VERSION = 'soa-mobile-v93-' + new URL(self.registration.scope).pathname;
const SHELL = [
    '/',
    '/index.html',
    '/styles.css',
    '/app.js',
    '/fullscreen.js',
    '/socket.js',
    '/ansi.js',
    '/terminal.js',
    '/voice-chat.js',
    '/chat-attachments.js',
    '/voice-chat.css',
    '/session-history.js',
    '/vendor/xterm-headless.mjs',
    '/agentDetect.js',
    '/keyboard.js',
    '/sounds.js',
    '/qrscan.js',
    // 130KB, precached deliberately: the scanner's whole job is recovering a
    // phone whose session is dead, and a lazy fetch at that moment is one more
    // thing that can fail. Only iOS (no BarcodeDetector) ever executes it.
    '/vendor/jsQR.min.js',
    '/manifest.webmanifest',
    '/icon.svg',
    '/audio/granted.wav',
    '/audio/denied.wav',
    '/audio/panels.wav',
    '/audio/keyboard.wav',
    '/audio/theme.wav',
].map(file => new URL(file.slice(1), self.registration.scope).href);

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil((async () => {
        const keys = await caches.keys();
        const scopePath = new URL(self.registration.scope).pathname;
        await Promise.all(keys.filter(k => k.startsWith('soa-mobile-') && k !== VERSION &&
            (!k.includes('-/') || k.endsWith('-' + scopePath))).map(k => caches.delete(k)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    const scope = new URL(self.registration.scope);
    if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
    // Don't cache API or WS upgrade calls
    if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

    if (req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html')) {
        e.respondWith((async () => {
            try {
                const fresh = await fetch(req);
                const cache = await caches.open(VERSION);
                if (fresh.ok) cache.put(new URL('index.html', scope).href, fresh.clone());
                return fresh;
            } catch (_) {
                const cached = await caches.match(new URL('index.html', scope).href);
                return cached || new Response('offline', { status: 503 });
            }
        })());
        return;
    }

    e.respondWith((async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        try {
            const fresh = await fetch(req);
            if (fresh.ok) {
                const cache = await caches.open(VERSION);
                cache.put(req, fresh.clone());
            }
            return fresh;
        } catch (_) {
            return new Response('offline', { status: 503 });
        }
    })());
});
