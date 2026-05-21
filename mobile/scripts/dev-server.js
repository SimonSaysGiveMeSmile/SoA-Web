#!/usr/bin/env node
/**
 * Local dev server for son-of-anton-mobile.
 *
 *   - Serves the static files under ./dist on a configurable port (default 5173).
 *   - If SOA_BRIDGE=ws://host:port is set, transparently proxies /ws and /api/*
 *     to that desktop bridge so the mobile app can be iterated against a live
 *     session without needing the bundled webapp to be in place.
 *   - Otherwise serves a friendly preview banner instead of opening a socket.
 *
 * Usage:
 *   node scripts/dev-server.js                       # static-only at :5173
 *   SOA_BRIDGE=ws://192.168.1.7:7330 node scripts/dev-server.js
 *   PORT=4000 node scripts/dev-server.js
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import net from 'node:net';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = Number(process.env.PORT) || 5173;
const BRIDGE = process.env.SOA_BRIDGE || null;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.mjs':  'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.ico':  'image/x-icon',
    '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
    const u = url.parse(req.url);
    const pathname = u.pathname === '/' ? '/index.html' : u.pathname;
    const file = path.join(ROOT, decodeURIComponent(pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }

    fs.stat(file, (err, stat) => {
        if (err || !stat.isFile()) {
            // SPA fallback
            const idx = path.join(ROOT, 'index.html');
            return fs.readFile(idx, (e, buf) => {
                if (e) { res.writeHead(404); return res.end('not found'); }
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                res.end(buf);
            });
        }
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });
}

function proxyHttpToBridge(req, res) {
    const target = new URL(req.url, BRIDGE.replace(/^ws/, 'http'));
    const opts = {
        method: req.method,
        host: target.hostname,
        port: target.port,
        path: target.pathname + (target.search || ''),
        headers: req.headers,
    };
    const proxied = http.request(opts, (pr) => {
        res.writeHead(pr.statusCode || 502, pr.headers);
        pr.pipe(res);
    });
    proxied.on('error', () => { res.writeHead(502); res.end('bridge unreachable'); });
    req.pipe(proxied);
}

function proxyUpgradeToBridge(req, clientSock, head) {
    const target = new URL(req.url, BRIDGE.replace(/^ws/, 'http'));
    const upstream = net.connect(target.port, target.hostname, () => {
        const headers = Object.entries(req.headers).map(([k,v]) => `${k}: ${v}`).join('\r\n');
        upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSock);
        clientSock.pipe(upstream);
    });
    upstream.on('error', () => { try { clientSock.end(); } catch (_) {} });
    clientSock.on('error', () => { try { upstream.end(); } catch (_) {} });
}

const server = http.createServer((req, res) => {
    if (BRIDGE && (req.url.startsWith('/api/') || req.url === '/ws')) {
        return proxyHttpToBridge(req, res);
    }
    serveStatic(req, res);
});

if (BRIDGE) {
    server.on('upgrade', proxyUpgradeToBridge);
}

server.listen(PORT, '0.0.0.0', () => {
    const addrs = listLanAddresses();
    console.log(`\n  son-of-anton-mobile · dev server`);
    console.log(`  → http://localhost:${PORT}`);
    addrs.forEach(a => console.log(`  → http://${a}:${PORT}`));
    if (BRIDGE) console.log(`\n  proxying /api/* and /ws to ${BRIDGE}\n`);
    else        console.log(`\n  no SOA_BRIDGE set → static preview only.`
                          + `\n  Append ?t=<token> to preview the paired UI flow.\n`);
});

function listLanAddresses() {
    const ifs = os.networkInterfaces();
    const out = [];
    for (const list of Object.values(ifs)) {
        for (const i of list || []) {
            if (i.family === 'IPv4' && !i.internal) out.push(i.address);
        }
    }
    return out;
}
