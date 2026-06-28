#!/usr/bin/env node
/**
 * SoA-Web tunnel stability verifier.
 *
 * Answers one question with numbers: "is the mobile tunnel actually stable
 * right now, and if not, where does it break?" It probes the REAL live tunnel
 * + the local backend — it does NOT spin up throwaway daemons (that's
 * stress.js). Read-only: it only issues GETs and opens a WS; it never mutates
 * fleet state.
 *
 * What it checks (each a PASS/FAIL line):
 *   backend     — local 127.0.0.1:PORT /api/ping hammered N× → proves the app
 *                 itself is solid, isolating "tunnel problem" from "app problem".
 *   discover    — what public URL is LIVE (ngrok :4040 / cloudflared log) vs what
 *                 channels.json / tunnel.json ADVERTISE. Mismatch = stale-link bug.
 *   tunnel-http — modest GET burst through the public URL. Classifies edge errors
 *                 (e.g. ngrok ERR_NGROK_727 = monthly quota exhausted) so a hard
 *                 403 wall isn't mistaken for "flaky".
 *   dns-flap    — repeatedly resolves the tunnel-provider control hosts over a
 *                 window; counts failures. This is the network-instability signal
 *                 behind ngrok "failed to reconnect session" storms.
 *   url-rotate  — watches :4040 across the window; flags if the public_url changes
 *                 mid-test (ngrok-free rotates the host on every reconnect).
 *   tunnel-ws   — opens /ws through the public URL with a correct Origin; measures
 *                 connect time / early close (the real mobile terminal path).
 *
 * Usage:
 *   node server/test/stress/tunnel-stability.js
 *     [--port 4010]            backend port to baseline + the port the tunnel fronts
 *     [--url https://…]        force a public URL (else auto-discovered)
 *     [--http 20]              tunnel HTTP probe count (kept modest — ngrok-free
 *                              counts every request against the monthly quota)
 *     [--local 200]            local-baseline request count
 *     [--window 30]            seconds for dns-flap + url-rotate monitors
 *     [--path /api/ping]       path to probe
 *     [--ws]                   also run the WS probe (off by default — burns a conn)
 */
const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
let WebSocket; try { WebSocket = require('ws'); } catch (_) { try { WebSocket = require(path.resolve(__dirname, '../../../node_modules/ws')); } catch (_2) { WebSocket = null; } }

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : def; }
function flag(name) { return process.argv.includes('--' + name); }
const CFG = {
    port: parseInt(arg('port', '4010'), 10),
    url: arg('url', ''),
    http: parseInt(arg('http', '20'), 10),
    local: parseInt(arg('local', '200'), 10),
    windowS: parseInt(arg('window', '30'), 10),
    path: arg('path', '/api/ping'),
    ws: flag('ws'),
};
const STATE_DIRS = [process.env.SOA_WEB_STATE_DIR, `${os.homedir()}/.soa-web-local`, `${os.homedir()}/.soa-web`].filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const C = { g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, c: s => `\x1b[36m${s}\x1b[0m` };
const results = [];
function record(name, pass, detail, metrics) {
    results.push({ name, pass, detail, metrics: metrics || {} });
    const tag = pass === 'warn' ? C.y('WARN') : pass ? C.g('PASS') : C.r('FAIL');
    console.log(`  ${tag}  ${C.b(name.padEnd(12))} ${C.d(detail)}`);
}
function pct(arr, p) { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; }

// ── one HTTP GET, returns {code, ms, errCode, err} ──────────────────────────
function getOnce(urlStr, { headers = {}, timeout = 10000 } = {}) {
    return new Promise(res => {
        let u; try { u = new URL(urlStr); } catch (e) { return res({ code: 0, ms: 0, err: 'bad-url' }); }
        const lib = u.protocol === 'https:' ? https : http;
        const t0 = process.hrtime.bigint();
        const req = lib.get(u, { headers, timeout }, r => {
            const errCode = r.headers['ngrok-error-code'] || r.headers['cf-mitigated'] || '';
            r.resume();
            r.on('end', () => res({ code: r.statusCode, ms: Number(process.hrtime.bigint() - t0) / 1e6, errCode }));
        });
        req.on('error', e => res({ code: 0, ms: Number(process.hrtime.bigint() - t0) / 1e6, err: e.code || e.message }));
        req.on('timeout', () => { req.destroy(); res({ code: 0, ms: timeout, err: 'timeout' }); });
    });
}

async function httpBurst(urlStr, count, opts) {
    const lat = [], codes = {}, errCodes = {}, errs = {};
    let ok = 0;
    for (let i = 0; i < count; i++) {
        const r = await getOnce(urlStr, opts);
        if (r.code === 200) { ok++; lat.push(r.ms); }
        codes[r.code] = (codes[r.code] || 0) + 1;
        if (r.errCode) errCodes[r.errCode] = (errCodes[r.errCode] || 0) + 1;
        if (r.err) errs[r.err] = (errs[r.err] || 0) + 1;
    }
    return { ok, count, lat, codes, errCodes, errs };
}
const fmtMap = m => Object.entries(m).map(([k, v]) => `${k}×${v}`).join(' ') || '—';

// ── discovery ───────────────────────────────────────────────────────────────
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
async function ngrokTunnels() {
    const r = await getOnce('http://127.0.0.1:4040/api/tunnels', { timeout: 4000 });
    if (r.code !== 200) return [];
    // getOnce drains the body; re-fetch with a body-capturing call
    return new Promise(res => {
        http.get('http://127.0.0.1:4040/api/tunnels', { timeout: 4000 }, resp => {
            let s = ''; resp.on('data', d => s += d);
            resp.on('end', () => { try { res((JSON.parse(s).tunnels || []).map(t => ({ url: t.public_url, addr: (t.config || {}).addr }))); } catch { res([]); } });
        }).on('error', () => res([])).on('timeout', function () { this.destroy(); res([]); });
    });
}
function cloudflaredLogUrl() {
    for (const d of STATE_DIRS) {
        for (const f of ['logs/cloudflared.log', 'logs/cf-respawn.log', 'logs/cf.log']) {
            try {
                const txt = fs.readFileSync(path.join(d, f), 'utf8');
                // quick-tunnel hosts are <random-words>.trycloudflare.com — NOT the
                // api.trycloudflare.com control host that shows up in error lines.
                const m = [...txt.matchAll(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/g)];
                if (m.length) return m[m.length - 1][0];
            } catch (_) {}
        }
    }
    return null;
}
async function discover() {
    const live = [];
    const ngs = await ngrokTunnels();
    for (const t of ngs) if (/^https/.test(t.url || '')) live.push({ url: t.url, via: 'ngrok', addr: t.addr });
    const cf = cloudflaredLogUrl();
    if (cf) live.push({ url: cf, via: 'cloudflared(log)' });
    const advertised = [];
    for (const d of STATE_DIRS) {
        const ch = readJson(path.join(d, 'channels.json'));
        if (ch && ch.url) advertised.push({ url: ch.url, src: `${path.basename(d)}/channels.json`, channel: ch.channel, verifiedAt: ch.verifiedAt });
        const tj = readJson(path.join(d, 'tunnel.json'));
        if (tj && (tj.url || tj.publicUrl)) advertised.push({ url: tj.url || tj.publicUrl, src: `${path.basename(d)}/tunnel.json` });
    }
    return { live, advertised, cfInstalled: fs.existsSync('/opt/homebrew/bin/cloudflared') || fs.existsSync('/usr/local/bin/cloudflared') };
}

const SKIP_HDR = { 'ngrok-skip-browser-warning': '1', 'User-Agent': 'soa-tunnel-stability/1' };

// ── scenarios ────────────────────────────────────────────────────────────────
async function scBackend() {
    const url = `http://127.0.0.1:${CFG.port}${CFG.path}`;
    const r = await httpBurst(url, CFG.local, { timeout: 3000 });
    const ok = r.ok === r.count;
    record('backend', ok, `${url} → ${r.ok}/${r.count} ok · p50=${pct(r.lat, 50).toFixed(2)}ms p99=${pct(r.lat, 99).toFixed(2)}ms · codes=[${fmtMap(r.codes)}]`, r);
    return ok;
}

let CHOSEN = null;
async function scDiscover() {
    const d = await discover();
    if (CFG.url) CHOSEN = CFG.url;
    else if (d.live.length) CHOSEN = d.live[0].url;
    else if (d.advertised.length) CHOSEN = d.advertised[0].url;
    const liveStr = d.live.map(l => `${l.url} ${C.d('(' + l.via + ')')}`).join(', ') || C.r('NONE running');
    console.log(`  ${C.c('•')}  ${C.b('live tunnels')} ${liveStr}`);
    for (const a of d.advertised) console.log(`  ${C.c('•')}  ${C.b('advertised ')} ${a.url} ${C.d('(' + a.src + (a.channel ? ', ch=' + a.channel : '') + (a.verifiedAt ? ', verified ' + a.verifiedAt : '') + ')')}`);
    // stale: an advertised URL that no live tunnel matches
    const liveUrls = new Set(d.live.map(l => l.url.replace(/\/$/, '')));
    const stale = d.advertised.filter(a => liveUrls.size && !liveUrls.has(a.url.replace(/\/$/, '')));
    if (!d.live.length) record('discover', false, `no live tunnel process found (ngrok :4040 empty, no cloudflared log url). cloudflared installed=${d.cfInstalled}`);
    else if (stale.length) record('discover', 'warn', `STALE advertised link(s) — saved URL ≠ live URL → mobile/s0a deep-links break: ${stale.map(s => s.src).join(', ')}`);
    else record('discover', true, `live URL matches advertised (no stale-link drift)`);
    return d;
}

async function scTunnelHttp() {
    if (!CHOSEN) { record('tunnel-http', false, 'no URL to probe'); return; }
    const url = `${CHOSEN.replace(/\/$/, '')}${CFG.path}`;
    const r = await httpBurst(url, CFG.http, { headers: SKIP_HDR, timeout: 10000 });
    const edge = Object.keys(r.errCodes);
    const quota = edge.some(e => /727|728|729/.test(e)); // ngrok account/quota family
    let detail = `${url} → ${r.ok}/${r.count} ok · codes=[${fmtMap(r.codes)}]`;
    if (edge.length) detail += ` · ${C.r('edge-err=[' + fmtMap(r.errCodes) + ']')}`;
    if (Object.keys(r.errs).length) detail += ` · neterr=[${fmtMap(r.errs)}]`;
    if (r.ok) detail += ` · p50=${pct(r.lat, 50).toFixed(0)}ms p95=${pct(r.lat, 95).toFixed(0)}ms`;
    if (quota) detail += ` ${C.r('← QUOTA EXHAUSTED (hard wall, not flaky)')}`;
    record('tunnel-http', r.ok === r.count, detail, r);
    return r;
}

// getaddrinfo (the path curl/node/ngrok/cloudflared actually use) vs raw DNS.
// A split — getaddrinfo fails or returns no IPv4 while `dig` resolves fine — is
// the macOS resolver dropping A records / negative-caching a flaky network DNS,
// which is what makes tunnels flap with "no such host" even though DNS is fine.
function digA(host) {
    return new Promise(res => {
        execFile('dig', ['+short', 'A', host, '@1.1.1.1'], { timeout: 6000 }, (err, out) => {
            if (err) return res([]);
            res((out || '').split('\n').map(s => s.trim()).filter(s => /^\d+\.\d+\.\d+\.\d+$/.test(s)));
        });
    });
}
async function getaddr4(host) {
    try { const r = await dns.lookup(host, { all: true, family: 4 }); return r.map(a => a.address); }
    catch (e) { return { err: e.code || e.message }; }
}
async function scDnsResolver() {
    const hosts = [];
    if (CHOSEN) { try { hosts.push(new URL(CHOSEN).hostname); } catch (_) {} }
    hosts.push('cloudflare.com'); // control: a well-known host should always resolve
    let broken = false; const lines = [];
    for (const h of hosts) {
        const [ga, dg] = await Promise.all([getaddr4(h), digA(h)]);
        const gaOk = Array.isArray(ga) && ga.length > 0;
        const dgOk = dg.length > 0;
        const split = !gaOk && dgOk; // resolver fails what real DNS answers
        if (split && h !== 'cloudflare.com') broken = true;
        lines.push(`${h}: getaddrinfo=${gaOk ? ga.join(',') : C.r(Array.isArray(ga) ? 'empty' : ga.err)} dig@1.1.1.1=${dgOk ? dg.join(',') : 'none'}${split ? C.r(' ←SPLIT') : ''}`);
    }
    record('dns-resolver', broken ? false : true, lines.join('  |  ') + (broken ? `  ${C.r('← OS resolver drops A records the network DNS is failing — fix: set 1.1.1.1/8.8.8.8 + flush cache')}` : ''), { broken });
    return broken;
}

async function scDnsFlap() {
    const hosts = ['connect.ngrok-agent.com', 'api.trycloudflare.com', 'google.com'];
    const per = {}; hosts.forEach(h => per[h] = { ok: 0, fail: 0 });
    const end = Date.now() + CFG.windowS * 1000;
    let rounds = 0;
    while (Date.now() < end) {
        rounds++;
        for (const h of hosts) { try { await dns.lookup(h); per[h].ok++; } catch (_) { per[h].fail++; } }
        await sleep(1500);
    }
    const totalFail = hosts.reduce((s, h) => s + per[h].fail, 0);
    const detail = hosts.map(h => `${h.split('.')[0]}=${per[h].ok}✓/${per[h].fail}✗`).join('  ') + `  (${rounds} rounds/${CFG.windowS}s)`;
    record('dns-flap', totalFail === 0 ? true : 'warn', detail + (totalFail ? `  ${C.y('← intermittent DNS loss = tunnel session drops')}` : ''), { per, totalFail });
    return totalFail;
}

async function scUrlRotate() {
    const end = Date.now() + CFG.windowS * 1000;
    const seen = new Set();
    while (Date.now() < end) {
        const ts = await ngrokTunnels();
        ts.forEach(t => t.url && seen.add(t.url));
        await sleep(3000);
    }
    const n = seen.size;
    if (n === 0) record('url-rotate', 'warn', 'no ngrok tunnel observed during window (cannot assess rotation)');
    else record('url-rotate', n <= 1, `${n} distinct public_url(s) during ${CFG.windowS}s window${n > 1 ? '  ' + C.r('← URL ROTATED mid-test (every saved link breaks)') : ' (stable)'}: ${[...seen].join(', ')}`);
    return n;
}

async function scTunnelWs() {
    if (!WebSocket) { record('tunnel-ws', 'warn', 'ws module unavailable — skipped'); return; }
    if (!CHOSEN) { record('tunnel-ws', false, 'no URL'); return; }
    const wsUrl = CHOSEN.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws';
    const origin = CHOSEN.replace(/\/$/, '');
    const t0 = Date.now();
    const out = await new Promise(res => {
        let done = false; const fin = v => { if (!done) { done = true; res(v); } };
        let ws; try { ws = new WebSocket(wsUrl, { headers: { Origin: origin, ...SKIP_HDR }, handshakeTimeout: 10000 }); } catch (e) { return fin({ ok: false, why: 'ctor:' + e.message }); }
        ws.on('open', () => { setTimeout(() => { try { ws.close(); } catch (_) {} fin({ ok: true, connectMs: Date.now() - t0 }); }, 2500); });
        ws.on('unexpected-response', (_req, r) => fin({ ok: false, why: `http ${r.statusCode}`, errCode: r.headers['ngrok-error-code'] }));
        ws.on('error', e => fin({ ok: false, why: e.message }));
        setTimeout(() => fin({ ok: false, why: 'handshake-timeout' }), 11000);
    });
    if (out.ok) record('tunnel-ws', true, `${wsUrl} → open in ${out.connectMs}ms, held 2.5s, clean close`);
    else record('tunnel-ws', false, `${wsUrl} → ${out.why}${out.errCode ? ' (' + out.errCode + ')' : ''}`);
}

(async () => {
    console.log(C.b(`\nSoA-Web tunnel stability  ·  port=${CFG.port} httpProbe=${CFG.http} localBaseline=${CFG.local} window=${CFG.windowS}s`));
    console.log(C.d(`read-only · probes the LIVE tunnel + local backend · never mutates fleet state\n`));
    await scBackend();
    await scDiscover();
    await scTunnelHttp();
    await scDnsResolver();
    console.log(C.d(`  … monitoring DNS + URL rotation for ${CFG.windowS}s …`));
    await Promise.all([scDnsFlap(), scUrlRotate()]);
    if (CFG.ws) await scTunnelWs();

    const fails = results.filter(r => r.pass === false).length;
    const warns = results.filter(r => r.pass === 'warn').length;
    const verdict = fails === 0 && warns === 0 ? C.g('STABLE') : fails === 0 ? C.y(`STABLE w/ ${warns} warning(s)`) : C.r(`UNSTABLE — ${fails} failure(s), ${warns} warning(s)`);
    console.log(`\n  ${C.b('VERDICT:')} ${verdict}\n`);
    process.exit(fails === 0 ? 0 : 1);
})();
