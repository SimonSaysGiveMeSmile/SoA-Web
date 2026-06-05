/**
 * Local web preview proxy.
 *
 * Lets a paired remote device (phone over the tunnel) view a web app running on
 * the host's localhost — the desktop can just open http://localhost:3000, but a
 * phone reaching this server through the tunnel can't. This reverse-proxies
 *
 *     /preview/<port>/<path>   →   http://127.0.0.1:<port>/<path>
 *
 * so the dev server is reachable through the same origin/tunnel the terminal
 * already uses (and behind the same session auth — see requireAuthed mount).
 *
 * HTML responses get a injected <base href="/preview/<port>/"> so relative
 * asset URLs resolve under the prefix. Absolute-path apps (asset URLs that
 * start with "/") and some SPAs may still need their dev server configured with
 * a matching base path. WebSocket upgrades (HMR) are proxied via proxyUpgrade().
 */

const http = require('http');
const net = require('net');

const HOST = '127.0.0.1';

function parsePreview(pathname) {
    const m = /^\/preview\/(\d{1,5})(\/.*)?$/.exec(pathname);
    if (!m) return null;
    const port = parseInt(m[1], 10);
    if (!(port > 0 && port < 65536)) return null;
    return { port, rest: m[2] || '/' };
}

// Strip headers that would block being framed or confuse the proxied origin.
function sanitizeResponseHeaders(headers, port) {
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        const lk = k.toLowerCase();
        if (lk === 'x-frame-options' || lk === 'content-security-policy' ||
            lk === 'content-security-policy-report-only') continue;
        if (lk === 'content-length') continue; // may change after base injection
        if (lk === 'location' && typeof v === 'string') {
            // Keep redirects inside the proxy prefix.
            out[k] = v.replace(/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+/i, `/preview/${port}`)
                      .replace(/^\//, `/preview/${port}/`);
            continue;
        }
        out[k] = v;
    }
    return out;
}

function mount(app, requireAuthed) {
    const handler = (req, res) => {
        const info = parsePreview(req.path);
        if (!info) { res.status(404).end('preview: bad port'); return; }
        const { port } = info;
        const upstreamPath = req.originalUrl.replace(/^\/preview\/\d+/, '') || '/';

        const headers = Object.assign({}, req.headers);
        headers.host = `${HOST}:${port}`;
        delete headers['accept-encoding']; // get plain text so we can inject <base>

        const preq = http.request({ host: HOST, port, method: req.method, path: upstreamPath, headers }, (pres) => {
            const ct = String(pres.headers['content-type'] || '');
            const outHeaders = sanitizeResponseHeaders(pres.headers, port);
            if (/text\/html/i.test(ct)) {
                const chunks = [];
                pres.on('data', (c) => chunks.push(c));
                pres.on('end', () => {
                    let html = Buffer.concat(chunks).toString('utf8');
                    const base = `<base href="/preview/${port}/">`;
                    if (!/<base\s/i.test(html)) {
                        if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + base);
                        else html = base + html;
                    }
                    res.writeHead(pres.statusCode, outHeaders);
                    res.end(html);
                });
            } else {
                res.writeHead(pres.statusCode, outHeaders);
                pres.pipe(res);
            }
        });
        preq.setTimeout(15000, () => preq.destroy(new Error('upstream timeout')));
        preq.on('error', (e) => {
            if (res.headersSent) { try { res.end(); } catch (_) {} return; }
            res.status(502).type('text/html').end(
                `<body style="font:14px monospace;background:#05080d;color:#aacfd1;padding:24px">` +
                `<h2>Preview unavailable</h2><p>Nothing is responding on <b>localhost:${port}</b>.</p>` +
                `<p style="opacity:.6">${String(e.message || e)}</p></body>`);
        });
        req.pipe(preq);
    };
    // Both the bare port and any sub-path go through the same handler.
    app.all('/preview/:port', requireAuthed, handler);
    app.all('/preview/:port/*', requireAuthed, handler);
}

// Raw WebSocket proxy for dev-server HMR. Call from the server 'upgrade'
// handler; returns true if it handled (consumed) the upgrade.
function proxyUpgrade(req, socket, head) {
    let pathname;
    try { pathname = new URL(req.url, 'http://x').pathname; } catch (_) { return false; }
    const info = parsePreview(pathname);
    if (!info) return false;
    const { port } = info;
    const upstreamPath = req.url.replace(/^\/preview\/\d+/, '') || '/';

    const upstream = net.connect(port, HOST, () => {
        const lines = [`${req.method} ${upstreamPath} HTTP/1.1`];
        const h = Object.assign({}, req.headers);
        h.host = `${HOST}:${port}`;
        for (const [k, v] of Object.entries(h)) {
            if (Array.isArray(v)) v.forEach((vv) => lines.push(`${k}: ${vv}`));
            else lines.push(`${k}: ${v}`);
        }
        upstream.write(lines.join('\r\n') + '\r\n\r\n');
        if (head && head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
    });
    upstream.on('error', () => { try { socket.destroy(); } catch (_) {} });
    socket.on('error', () => { try { upstream.destroy(); } catch (_) {} });
    return true;
}

module.exports = { mount, proxyUpgrade };
