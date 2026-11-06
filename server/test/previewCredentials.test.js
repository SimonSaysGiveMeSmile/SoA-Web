'use strict';
// server/src/preview.js: the proxy authenticates at the daemon boundary, so
// the previewed app must never receive SoA's pairing/unlock credentials —
// neither the ?t= / ?u= query, nor Authorization / x-soa-unlock /
// x-soa-local-key, nor the soa_web_auth / soa_web_unlock cookies. Everything else the browser sent passes through.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const preview = require('../src/preview');

// A stand-in for the previewed app: records what each request carried.
function startUpstream() {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push({ url: req.url, headers: req.headers });
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
    });
    server.on('upgrade', (req, socket) => {
        seen.push({ url: req.url, headers: req.headers });
        socket.end('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

// The daemon side: mount() on a minimal app shim, served by a plain http server.
function startProxy() {
    const routes = [];
    const app = { all: (pattern, _auth, handler) => routes.push(handler) };
    preview.mount(app, (_req, _res, next) => next());
    const handler = routes[0];
    const server = http.createServer((req, res) => {
        req.originalUrl = req.url;
        req.path = new URL(req.url, 'http://x').pathname;
        res.status = (code) => { res.statusCode = code; return res; };
        res.type = () => res;
        handler(req, res);
    });
    server.on('upgrade', (req, socket, head) => {
        if (!preview.proxyUpgrade(req, socket, head)) socket.destroy();
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

const CRED_HEADERS = {
    authorization: 'Bearer pair-token',
    'proxy-authorization': 'Basic abc',
    cookie: 'soa_web_auth=secret; app_session=keep-me; SOA_WEB_UNLOCK=also-secret; theme=dark',
    'x-soa-unlock': 'unlock-token',
    'x-soa-local-key': 'local-key',
    'x-app-header': 'kept',
};

function get(port, path, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end();
    });
}

let up, px;
test.before(async () => { up = await startUpstream(); px = await startProxy(); });
test.after(() => { up.server.close(); px.server.close(); });

test('HTTP: t/u leave the forwarded path, other query is kept', async () => {
    const status = await get(px.port, `/preview/${up.port}/app/page?t=pair-token&q=1&u=unlock&x=a%20b`, CRED_HEADERS);
    assert.equal(status, 200);
    const got = up.seen.at(-1);
    const url = new URL(got.url, 'http://x');
    assert.equal(url.pathname, '/app/page');
    assert.equal(url.searchParams.has('t'), false);
    assert.equal(url.searchParams.has('u'), false);
    assert.equal(url.searchParams.get('q'), '1');
    assert.equal(url.searchParams.get('x'), 'a b');
});

test('HTTP: the rest of the query is forwarded byte-for-byte, encoded names included', async () => {
    await get(px.port, `/preview/${up.port}/a//b?%74=enc&y=%2F+z&flag&u=x&q=1`, {});
    assert.equal(up.seen.at(-1).url, '/a//b?y=%2F+z&flag&q=1');
});

test('HTTP: auth and SoA cookies are removed, other cookies and headers kept', async () => {
    await get(px.port, `/preview/${up.port}/`, CRED_HEADERS);
    const h = up.seen.at(-1).headers;
    assert.equal(h.authorization, undefined);
    assert.equal(h['proxy-authorization'], undefined);
    assert.equal(h['x-soa-unlock'], undefined);
    assert.equal(h['x-soa-local-key'], undefined);
    assert.equal(h.cookie, 'app_session=keep-me; theme=dark');
    assert.equal(h['x-app-header'], 'kept');
    assert.equal(h.host, `127.0.0.1:${up.port}`);
});

test('HTTP: a cookie header holding only SoA cookies is dropped entirely', async () => {
    await get(px.port, `/preview/${up.port}/?t=only`, { cookie: 'soa_web_auth=a; soa_web_unlock=b' });
    const got = up.seen.at(-1);
    assert.equal(got.headers.cookie, undefined);
    assert.equal(got.url, '/');
});

test('WebSocket upgrade: the same credentials are stripped', async () => {
    await new Promise((resolve, reject) => {
        const sock = net.connect(px.port, '127.0.0.1', () => {
            sock.write([
                `GET /preview/${up.port}/hmr?u=unlock&token=app&t=pair HTTP/1.1`,
                `host: 127.0.0.1:${px.port}`,
                'connection: Upgrade',
                'upgrade: websocket',
                'authorization: Bearer pair-token',
                'cookie: soa_web_unlock=s; app=1',
                '', ''].join('\r\n'));
        });
        sock.on('data', (d) => { if (String(d).includes('101')) { sock.destroy(); resolve(); } });
        sock.on('error', reject);
    });
    const got = up.seen.at(-1);
    assert.equal(got.url, '/hmr?token=app');
    assert.equal(got.headers.authorization, undefined);
    assert.equal(got.headers.cookie, 'app=1');
});
