#!/usr/bin/env node
/**
 * SoA-Web mock stress harness.
 *
 * Spins up THROWAWAY, fully-isolated daemons (own port + temp STATE_DIR + temp
 * HOME, no tunnel, no claude — tabs are mock shells) and hammers them to
 * reproduce the stability/clobber failure modes and prove the fixes. It never
 * touches the real fleet (:4010/:7332) or ~/.soa-web*.
 *
 * Scenarios:
 *   scale        — open N tabs, assert all present (live+disk) + responsive + RSS
 *   gc-survival  — idle a tab-bearing fleet past the TTL; assert it SURVIVES
 *                  (and, via SOA_WEB_GC_REAP_LIVE=1, that the OLD code reaped it)
 *   reconnect    — connect/disconnect many clients fast; assert no hang/clobber
 *   restart      — SIGTERM + relaunch; assert boot-resume rehydrates, no loss
 *   integrity    — sample tabs.json under churn; assert never empty/corrupt
 *
 * Usage:  node server/test/stress/stress.js [--tabs 20] [--clients 30]
 *                                           [--cycles 2] [--only scale,restart]
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
let WebSocket; try { WebSocket = require('ws'); } catch (_) { WebSocket = require(path.resolve(__dirname, '../../../node_modules/ws')); }

const REPO = path.resolve(__dirname, '../../..');
const ENTRY = path.join(REPO, 'server/src/index.js');
const NODE = process.execPath;

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : def; }
const CFG = {
    tabs: parseInt(arg('tabs', '20'), 10),
    clients: parseInt(arg('clients', '30'), 10),
    cycles: parseInt(arg('cycles', '2'), 10),
    only: (arg('only', '') || '').split(',').filter(Boolean),
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const C = { g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m` };

// ── port + daemon lifecycle ───────────────────────────────────────────────────
function freePort() {
    return new Promise((res, rej) => {
        const srv = net.createServer(); srv.unref();
        srv.on('error', rej);
        srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); });
    });
}
function ping(port) {
    return new Promise(res => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1500 }, r => { r.resume(); res(r.statusCode === 200); });
        req.on('error', () => res(false)); req.on('timeout', () => { req.destroy(); res(false); });
    });
}
async function spawnDaemon(opts = {}) {
    const port = opts.port || await freePort();
    const stateDir = opts.stateDir || fs.mkdtempSync(path.join(os.tmpdir(), 'soa-stress-state-'));
    const homeDir = opts.homeDir || fs.mkdtempSync(path.join(os.tmpdir(), 'soa-stress-home-'));
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    const env = {
        ...process.env,
        HOME: homeDir,
        SOA_WEB_HOST: '127.0.0.1',
        SOA_WEB_PORT: String(port),
        SOA_WEB_STATE_DIR: stateDir,
        SOA_WEB_AUTOPAIR: '0',
        SOA_WEB_NO_AUTO_RESUME: '1',
        SOA_WEB_DEV: '1',
        // New tabs persist on the periodic flush (NEW_TAB opens silent), default
        // 30s. Crank it to 1s so the harness observes tabs.json promptly.
        SOA_WEB_SCROLLBACK_FLUSH_MS: '1000',
    };
    if (opts.ttlMs != null) env.SOA_WEB_SESSION_TTL_MS = String(opts.ttlMs);
    if (opts.sweepMs != null) env.SOA_WEB_GC_SWEEP_MS = String(opts.sweepMs);
    if (opts.noBootResume) env.SOA_WEB_NO_BOOT_RESUME = '1';
    env.SOA_WEB_GC_REAP_LIVE = opts.reapLive ? '1' : '0';
    const logfd = fs.openSync(path.join(stateDir, 'logs', 'daemon.log'), 'a');
    const child = spawn(NODE, [ENTRY], { env, stdio: ['ignore', logfd, logfd] });
    for (let i = 0; i < 80; i++) { if (await ping(port)) break; await sleep(150); }
    if (!await ping(port)) throw new Error(`daemon on :${port} never became ready (log: ${stateDir}/logs/daemon.log)`);
    return { child, port, stateDir, homeDir };
}
async function killDaemon(d, sig = 'SIGTERM') {
    if (!d || !d.child || d.child.killed) return;
    d.child.kill(sig);
    for (let i = 0; i < 40; i++) { if (!(await ping(d.port))) break; await sleep(150); }
    if (await ping(d.port)) d.child.kill('SIGKILL');
}
function cleanup(d) { try { fs.rmSync(d.stateDir, { recursive: true, force: true }); } catch (_) {} try { fs.rmSync(d.homeDir, { recursive: true, force: true }); } catch (_) {} }
function rss(child) { try { return parseInt(execSync(`ps -o rss= -p ${child.pid}`).toString().trim(), 10) * 1024; } catch (_) { return 0; } }

// ── client (provision + WS + mock tabs) ───────────────────────────────────────
function provision(port) {
    return new Promise((res, rej) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/me' }, r => {
            const cookies = r.headers['set-cookie'] || []; r.resume();
            r.on('end', () => res(cookies.map(c => c.split(';')[0]).join('; ')));
        });
        req.on('error', rej); req.end();
    });
}
function apiTabs(port) {
    return new Promise(res => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/tabs', timeout: 3000 }, r => {
            let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s).tabs || []); } catch { res(null); } });
        });
        req.on('error', () => res(null)); req.on('timeout', () => { req.destroy(); res(null); });
    });
}
function readTabsJson(stateDir) {
    try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'tabs.json'), 'utf8')); } catch (_) { return null; }
}
// Persistence is debounced (500ms) + atomic tmp+rename, so poll past the debounce
// rather than racing it.
async function pollTabsJson(stateDir, minCount, timeoutMs = 3000) {
    const t0 = Date.now(); let last = null;
    while (Date.now() - t0 < timeoutMs) {
        const j = readTabsJson(stateDir);
        if (j && Array.isArray(j.tabs) && j.tabs.length >= minCount) return j;
        last = j; await sleep(150);
    }
    return last;
}
async function connectWS(port, jar) {
    if (!jar) jar = await provision(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: jar } });
    ws._jar = jar; ws._resolveSnap = null;
    ws.on('message', raw => { let m; try { m = JSON.parse(raw.toString()); } catch { return; } if (m.t === 'snapshot' && ws._resolveSnap) { const r = ws._resolveSnap; ws._resolveSnap = null; r(m.d); } });
    await new Promise((resolve, reject) => { ws.on('error', reject); ws.once('open', () => resolve()); });
    await sleep(250); // let hello + initial snapshot land
    return ws;
}
function send(ws, kind, d) { ws.send(JSON.stringify({ v: 1, t: 'input', d: { kind, ...d } })); }
async function openTab(ws, cwd) {
    const snap = await new Promise(res => { ws._resolveSnap = res; send(ws, 'new-tab', { cwd, cols: 200, rows: 50 }); });
    return snap && snap.activeId;
}
async function mockOutput(ws, tabId, lines = 40) {
    send(ws, 'shell-command', { id: tabId, line: `for i in $(seq 1 ${lines}); do echo "stress tab ${tabId} line $i"; done` });
    await sleep(60);
}

// ── scenarios ──────────────────────────────────────────────────────────────
const results = [];
function record(name, pass, detail, metrics) { results.push({ name, pass, detail, metrics: metrics || {} }); console.log(`  ${pass ? C.g('PASS') : C.r('FAIL')}  ${C.b(name)}  ${C.d(detail)}`); }

async function scScale() {
    const d = await spawnDaemon();
    try {
        const ws = await connectWS(d.port);
        const t0 = Date.now();
        for (let i = 0; i < CFG.tabs; i++) { const id = await openTab(ws, REPO); if (i % 5 === 0) await mockOutput(ws, id, 30); }
        const openMs = Date.now() - t0;
        const disk = await pollTabsJson(d.stateDir, CFG.tabs, 4000);
        const tlatT0 = Date.now(); const live = await apiTabs(d.port); const apiMs = Date.now() - tlatT0;
        const mb = (rss(d.child) / 1048576).toFixed(0);
        ws.close();
        const ok = live && live.length >= CFG.tabs && disk && disk.tabs.length >= CFG.tabs && apiMs < 2000;
        record('scale', ok, `${CFG.tabs} tabs → live=${live ? live.length : 'ERR'} disk=${disk ? disk.tabs.length : 'ERR'} open=${openMs}ms api=${apiMs}ms rss=${mb}MB`, { openMs, apiMs, mb });
    } finally { await killDaemon(d); cleanup(d); }
}

async function gcOnce(reapLive) {
    const d = await spawnDaemon({ ttlMs: 2500, sweepMs: 700, reapLive });
    try {
        const ws = await connectWS(d.port);
        const n = Math.min(12, CFG.tabs);
        for (let i = 0; i < n; i++) await openTab(ws, REPO);
        await pollTabsJson(d.stateDir, n, 4000);            // ensure persisted before idling
        const before = ((await apiTabs(d.port)) || []).length;
        ws.close();                                          // disconnect → session idles, lastSeen frozen
        await sleep(5500);                                   // > ttl(2.5s) + several sweeps(0.7s)
        const afterLive = ((await apiTabs(d.port)) || []).length; // HTTP read only — does NOT trigger restore-on-connect
        const afterDisk = readTabsJson(d.stateDir);
        return { before, afterLive, afterDisk: afterDisk ? afterDisk.tabs.length : 0 };
    } finally { await killDaemon(d); cleanup(d); }
}
async function scGcSurvival() {
    const fixed = await gcOnce(false);
    const okFixed = fixed.before > 0 && fixed.afterLive >= fixed.before;
    record('gc-survival (fixed)', okFixed, `idle past TTL: before=${fixed.before} → live=${fixed.afterLive} disk=${fixed.afterDisk} (live fleet must survive)`, fixed);
    let okContrast = false, old;
    try {
        old = await gcOnce(true);
        okContrast = old.before > 0 && old.afterLive < old.before; // old code reaps the idle live fleet
        record('gc-survival (pre-fix A/B)', okContrast, `SOA_WEB_GC_REAP_LIVE=1: before=${old.before} → live=${old.afterLive} (old code SHOULD reap → proves the test has teeth)`, old);
    } catch (e) { record('gc-survival (pre-fix A/B)', false, 'A/B run errored: ' + (e.message || e)); }
}

async function scReconnect() {
    const d = await spawnDaemon();
    try {
        const ws = await connectWS(d.port);
        const base = Math.min(15, CFG.tabs);
        for (let i = 0; i < base; i++) { const id = await openTab(ws, REPO); if (i % 3 === 0) await mockOutput(ws, id, 50); }
        await pollTabsJson(d.stateDir, base, 4000);
        const jar = ws._jar;            // reuse same cookie → exercise share-primary
        let errs = 0;
        for (let i = 0; i < CFG.clients; i++) {
            try { const c = await connectWS(d.port, jar); await sleep(25 + (i % 5) * 10); c.close(); } catch (_) { errs++; }
        }
        await sleep(400);
        const t0 = Date.now(); const live = await apiTabs(d.port); const apiMs = Date.now() - t0;
        const disk = readTabsJson(d.stateDir);
        ws.close();
        const ok = live && live.length >= base && disk && disk.tabs.length >= base && apiMs < 2500 && errs === 0;
        record('reconnect', ok, `${CFG.clients} connect/disconnect cycles → errs=${errs} live=${live ? live.length : 'ERR'} disk=${disk ? disk.tabs.length : 'ERR'} api=${apiMs}ms`, { errs, apiMs });
    } finally { await killDaemon(d); cleanup(d); }
}

async function scRestart() {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-stress-state-'));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-stress-home-'));
    const port = await freePort();
    let d = await spawnDaemon({ port, stateDir, homeDir });
    try {
        const ws = await connectWS(d.port);
        const n = Math.min(15, CFG.tabs);
        for (let i = 0; i < n; i++) { const id = await openTab(ws, REPO); if (i % 4 === 0) await mockOutput(ws, id, 40); }
        ws.close();
        const seeded = ((await pollTabsJson(stateDir, n, 4000)) || { tabs: [] }).tabs.length;
        const rehydrated = [];
        for (let cyc = 1; cyc <= CFG.cycles; cyc++) {
            await killDaemon(d, 'SIGTERM');                  // graceful: flushes current tabs
            d = await spawnDaemon({ port, stateDir, homeDir }); // boot-resume should rehydrate headlessly
            let live = 0;
            for (let i = 0; i < 60; i++) { const t = await apiTabs(d.port); live = t ? t.length : 0; if (live >= seeded) break; await sleep(300); }
            rehydrated.push(live);
        }
        const ok = seeded > 0 && rehydrated.every(v => v >= seeded);
        record('restart', ok, `seeded=${seeded} → rehydrated per cycle=[${rehydrated.join(',')}] (boot-resume, no clobber)`, { seeded, rehydrated });
    } finally { await killDaemon(d); try { fs.rmSync(stateDir, { recursive: true, force: true }); fs.rmSync(homeDir, { recursive: true, force: true }); } catch (_) {} }
}

async function scIntegrity() {
    const d = await spawnDaemon();
    try {
        const ws = await connectWS(d.port);
        let everEmpty = false, everCorrupt = false, samples = 0;
        const target = Math.min(18, CFG.tabs);
        const sampler = setInterval(() => {
            samples++;
            const j = readTabsJson(d.stateDir);
            if (j === null) { /* file briefly absent before first debounced write — tolerated */ }
            else if (!Array.isArray(j.tabs)) everCorrupt = true;
            else if (j.tabs.length === 0 && j.closedByUser !== true) everEmpty = true;
        }, 50);
        for (let i = 0; i < target; i++) { const id = await openTab(ws, REPO); if (i % 2 === 0) await mockOutput(ws, id, 30); }
        for (let i = 0; i < Math.min(10, CFG.clients); i++) { const c = await connectWS(d.port, ws._jar); await sleep(40); c.close(); }
        const disk = await pollTabsJson(d.stateDir, target, 4000);
        clearInterval(sampler);
        ws.close();
        const ok = !everEmpty && !everCorrupt && disk && disk.tabs.length >= target;
        record('integrity', ok, `${samples} tabs.json samples under churn → everEmpty=${everEmpty} everCorrupt=${everCorrupt} final=${disk ? disk.tabs.length : 'ERR'}`, { samples, everEmpty, everCorrupt });
    } finally { await killDaemon(d); cleanup(d); }
}

const ALL = { scale: scScale, 'gc-survival': scGcSurvival, reconnect: scReconnect, restart: scRestart, integrity: scIntegrity };

(async () => {
    console.log(C.b(`\nSoA-Web stress harness  ·  tabs=${CFG.tabs} clients=${CFG.clients} cycles=${CFG.cycles}`));
    console.log(C.d(`isolated throwaway daemons · prod (:4010/:7332) untouched\n`));
    const names = CFG.only.length ? CFG.only : Object.keys(ALL);
    for (const name of names) {
        const fn = ALL[name]; if (!fn) { console.log(C.r(`  unknown scenario: ${name}`)); continue; }
        try { await fn(); } catch (e) { record(name, false, 'threw: ' + (e.message || e)); }
    }
    const pass = results.filter(r => r.pass).length, total = results.length;
    console.log(`\n${pass === total ? C.g('ALL PASS') : C.r('FAILURES')}  ${pass}/${total}\n`);
    process.exit(pass === total ? 0 : 1);
})();
