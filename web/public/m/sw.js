/**
 * Minimal service worker for the mobile companion PWA.
 *
 * Strategy: "shell-cache, network-first for HTML, cache-first for static
 * assets". The actual session data flows over WebSocket, never HTTP, so this
 * SW is purely about making the app installable and fast to launch.
 */

const VERSION = 'soa-mobile-v26';
const SHELL = [
    '/',
    '/index.html',
    '/styles.css',
    '/app.js',
    '/socket.js',
    '/ansi.js',
    '/keyboard.js',
    '/sounds.js',
    '/manifest.webmanifest',
    '/icon.svg',
    '/audio/granted.wav',
    '/audio/denied.wav',
    '/audio/panels.wav',
    '/audio/keyboard.wav',
    '/audio/theme.wav',
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    // Don't cache API or WS upgrade calls
    if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

    if (req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html')) {
        e.respondWith((async () => {
            try {
                const fresh = await fetch(req);
                const cache = await caches.open(VERSION);
                cache.put(req, fresh.clone());
                return fresh;
            } catch (_) {
                const cached = await caches.match('/index.html');
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
