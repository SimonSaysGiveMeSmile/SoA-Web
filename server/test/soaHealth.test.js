'use strict';
// scripts/soa-health: detection, protection, PID-reuse guard, rate limit,
// settings gate and the HTTP guard. No real process is ever signalled here:
// the server under test runs with an empty test allowlist and notify-dry.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'soa-health');
const H = require(SCRIPT);

const UID = 501;
function proc(pid, ppid, comm, extra = {}) {
    const name = path.basename(comm);
    const i = comm.indexOf('.app/');
    return Object.assign({ pid, ppid, uid: UID, pcpu: 0, rssKB: 1000, cpuSec: 0, startTime: 1_700_000_000_000 + pid, comm, args: comm, name,
        app: i > 0 ? path.basename(comm.slice(0, i)) : null }, extra);
}
function ctxOf(procs, extra = {}) {
    return Object.assign({ uid: UID, selfPid: 9000, selfChain: new Set([9000, 8999]), daemonPids: new Set([100]),
        byPid: new Map(procs.map((p) => [p.pid, p])), frontmost: null, allowlist: [] }, extra);
}

// ── settings ──
test('defaults: notify mode, monitor on, auto-terminate off', () => {
    const s = H.defaultSettings();
    assert.equal(s.mode, 'notify'); assert.equal(s.enabled, true); assert.equal(s.dryRun, false);
    assert.equal(s.thresholds.cpuPct, 85); assert.equal(s.thresholds.sustainSamples, 3);
    assert.equal(s.thresholds.rssPctOfRam, 25); assert.equal(s.thresholds.leakMB, 1024); assert.equal(s.thresholds.leakWindowMin, 10);
    assert.deepEqual(s.rate, { max: 3, windowMin: 10, commandCooldownMin: 30 });
});
test('turning auto on requires the explicit confirm phrase', () => {
    const cur = H.defaultSettings();
    const no = H.applySettingsPatch(cur, { mode: 'auto' });
    assert.ok(no.error); assert.equal(no.needConfirm, H.AUTO_CONFIRM);
    const yes = H.applySettingsPatch(cur, { mode: 'auto', confirm: H.AUTO_CONFIRM });
    assert.equal(yes.settings.mode, 'auto'); assert.ok(yes.settings.autoEnabledAt);
    const back = H.applySettingsPatch(yes.settings, { mode: 'notify' });
    assert.equal(back.settings.mode, 'notify'); assert.equal(back.settings.autoEnabledAt, null);
    assert.ok(H.applySettingsPatch(cur, { mode: 'kill-all' }).error);
});
test('settings are clamped and lists cleaned', () => {
    const r = H.applySettingsPatch(H.defaultSettings(), { intervalSec: 5, thresholds: { sustainSamples: 0, cpuPct: 'x' }, allowlist: [' Xcode ', '', 'Xcode'] });
    assert.ok(r.settings.intervalSec >= 1 && r.settings.intervalSec <= 600);
    assert.equal(r.settings.thresholds.sustainSamples, 1);
    assert.equal(r.settings.thresholds.cpuPct, 85);
    assert.deepEqual(r.settings.allowlist, ['Xcode']);
});

// ── parsing ──
test('ps parsing: cputime formats, lstart, app names', () => {
    assert.equal(H.parseCpuTime('1:02.50'), 62.5);
    assert.equal(H.parseCpuTime('01:00:00'), 3600);
    assert.equal(H.parseCpuTime('2-00:00:01'), 172801);
    const out = '  321     1   501  97.5  204800  12:01.00 Thu Oct 30 11:38:01 2026     /Applications/Foo Bar.app/Contents/MacOS/Foo Bar\n';
    const [p] = H.parsePs(out, '  321 /Applications/Foo Bar.app/Contents/MacOS/Foo Bar --flag\n');
    assert.equal(p.pid, 321); assert.equal(p.cpuSec, 721); assert.equal(p.app, 'Foo Bar'); assert.equal(p.name, 'Foo Bar');
    assert.equal(p.args, '/Applications/Foo Bar.app/Contents/MacOS/Foo Bar --flag');
    assert.equal(p.startTime, new Date(2026, 9, 30, 11, 38, 1).getTime());
});

// ── detection ──
function settings(over = {}) { return H.normalizeSettings(Object.assign(H.defaultSettings(), over)); }
test('CPU must be sustained for N consecutive samples', () => {
    const s = settings(); const d = new H.Detector();
    let t = 1_000_000; let cpuSec = 0;
    const tick = (pct) => { cpuSec += pct / 100 * 60; t += 60000; const p = proc(500, 1, '/usr/local/bin/burn', { cpuSec, pcpu: pct }); d.update([p], t, s); return H.reasonsFor(p, s, 60, t); };
    tick(99);                         // first sight: pcpu fallback
    assert.equal(tick(99).length, 0); // run 2
    const r = tick(99);               // run 3 → candidate
    assert.equal(r.length, 1); assert.equal(r[0].kind, 'cpu'); assert.ok(r[0].value >= 98);
    assert.equal(tick(10).length, 0); // a dip resets the run
    assert.equal(tick(99).length, 0);
});
test('a reused pid (new start time) starts from zero', () => {
    const s = settings(); const d = new H.Detector();
    for (let i = 1; i <= 3; i++) d.update([proc(600, 1, '/x/burn', { pcpu: 99, cpuSec: i * 59 })], i * 60000, s);
    const fresh = proc(600, 1, '/x/burn', { pcpu: 99, cpuSec: 1, startTime: 42 });
    d.update([fresh], 4 * 60000, s);
    assert.equal(fresh.track.cpuRun, 1);
    assert.equal(H.reasonsFor(fresh, s, 60, 4 * 60000).length, 0);
});
test('memory over % of RAM, sustained', () => {
    const s = settings({ thresholds: { rssPctOfRam: 1, sustainSamples: 2 } }); const d = new H.Detector();
    const big = Math.ceil(os.totalmem() * 0.02 / 1024);
    let p;
    for (let i = 1; i <= 2; i++) { p = proc(700, 1, '/x/hog', { rssKB: big, cpuSec: 0 }); d.update([p], i * 60000, s); }
    const r = H.reasonsFor(p, s, 60, 2 * 60000);
    assert.equal(r[0].kind, 'memory');
});
test('leak: growth over the window', () => {
    const s = settings({ thresholds: { leakMB: 512, leakWindowMin: 10, rssPctOfRam: 95 } }); const d = new H.Detector();
    let p, t = 0;
    for (let i = 0; i <= 10; i++) { t = i * 60000; p = proc(800, 1, '/x/leaky', { rssKB: (100 + i * 60) * 1024, cpuSec: 0 }); d.update([p], t, s); }
    const r = H.reasonsFor(p, s, 60, t);
    assert.equal(r.length, 1); assert.equal(r[0].kind, 'leak'); assert.ok(r[0].value >= 512);
    // not yet a full window: no leak
    const d2 = new H.Detector(); let q;
    for (let i = 0; i <= 5; i++) { q = proc(801, 1, '/x/leaky', { rssKB: (100 + i * 300) * 1024 }); d2.update([q], i * 60000, s); }
    assert.equal(H.reasonsFor(q, s, 60, 5 * 60000).length, 0);
});
test('denylisted processes are flagged on the first over-threshold sample', () => {
    const s = settings({ denylist: ['burn'] }); const d = new H.Detector();
    const p = proc(900, 1, '/x/burn', { pcpu: 99 });
    d.update([p], 60000, s);
    assert.equal(H.reasonsFor(p, s, 60, 60000)[0].kind, 'cpu');
});

// ── protection ──
test('protection: kernel, system names and system paths', () => {
    const c = ctxOf([]);
    assert.ok(H.protectReason(proc(1, 0, '/sbin/launchd'), c));
    assert.ok(H.protectReason(proc(0, 0, 'kernel_task'), c));
    for (const n of ['WindowServer', 'loginwindow', 'Dock', 'Finder', 'SystemUIServer', 'ControlCenter', 'coreaudiod'])
        assert.ok(H.protectReason(proc(2000, 1, '/some/where/' + n), c), n);
    assert.match(H.protectReason(proc(2001, 1, '/System/Library/CoreServices/Foo'), c), /system path/);
    assert.match(H.protectReason(proc(2002, 1, '/usr/libexec/bar'), c), /system path/);
    assert.match(H.protectReason(proc(2003, 1, '/usr/sbin/baz'), c), /system path/);
    assert.equal(H.protectReason(proc(2004, 1, '/usr/bin/yes'), c), null);
});
test('protection: SoA daemon and every descendant', () => {
    const daemon = proc(100, 1, '/opt/homebrew/bin/node', { args: 'node /home/u/.soa-web/server/src/index.js' });
    const shell = proc(101, 100, '/bin/zsh');
    const agent = proc(102, 101, '/usr/local/bin/node', { args: 'node /usr/local/lib/node_modules/some-tool/cli.js' });
    const tool = proc(103, 102, '/usr/bin/yes');
    const c = ctxOf([daemon, shell, agent, tool]);
    assert.match(H.protectReason(daemon, c), /SoA/);
    assert.match(H.protectReason(tool, c), /SoA session/);
    // found by command line even without daemon.lock
    const c2 = ctxOf([daemon, shell, agent, tool], { daemonPids: new Set() });
    assert.match(H.protectReason(tool, c2), /SoA/);
});
test('protection: soa services and their children, launchd job names', () => {
    const dict = proc(300, 1, '/opt/homebrew/bin/node', { args: 'node /home/u/.soa-web/scripts/soa-dictate' });
    const child = proc(301, 300, '/opt/homebrew/bin/whisper-server');
    const quota = proc(302, 1, '/opt/homebrew/bin/node', { args: 'node /opt/x/usageQuota.js' });
    const remote = proc(303, 1, '/opt/homebrew/bin/node', { args: 'node scripts/soa-desktop-remote' });
    const c = ctxOf([dict, child, quota, remote]);
    for (const p of [dict, child, quota, remote]) assert.ok(H.protectReason(p, c), p.args);
});
test('protection: tunnels, terminals, agents, Sarea, SoA Pointer', () => {
    const c = ctxOf([]);
    for (const comm of ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/ngrok', '/usr/bin/ssh', '/opt/homebrew/bin/autossh',
        '/Applications/iTerm.app/Contents/MacOS/iTerm2', '/Applications/Sarea.app/Contents/MacOS/Sarea',
        '/Applications/SoA Pointer.app/Contents/MacOS/SoA Pointer', '/Users/u/.local/bin/claude', '/opt/homebrew/bin/tmux'])
        assert.ok(H.protectReason(proc(4000, 1, comm), c), comm);
    assert.ok(H.protectReason(proc(4001, 1, '/opt/homebrew/bin/node', { args: 'node /x/node_modules/@anthropic-ai/claude-code/cli.js' }), c));
    // a helper of a protected app bundle
    assert.ok(H.protectReason(proc(4002, 1, '/Applications/Sarea.app/Contents/Helpers/worker'), c));
});
test('protection: the frontmost app (and its helpers), self + parent, allowlist', () => {
    const front = proc(5000, 1, '/Applications/Browser.app/Contents/MacOS/Browser');
    const helper = proc(5001, 5000, '/Applications/Browser.app/Contents/Frameworks/H.app/Contents/MacOS/H');
    const c = ctxOf([front, helper], { frontmost: { pid: 5000, bundlePath: '/Applications/Browser.app' } });
    assert.equal(H.protectReason(front, c), 'frontmost app');
    assert.equal(H.protectReason(helper, c), 'frontmost app');
    assert.ok(H.protectReason(proc(9000, 1, '/x/node'), c));
    assert.ok(H.protectReason(proc(8999, 1, '/bin/zsh'), c));
    const c2 = ctxOf([], { allowlist: ['Render', '/opt/keep/'] });
    assert.match(H.protectReason(proc(5100, 1, '/Applications/Render.app/Contents/MacOS/Render'), c2), /allowlist/);
    assert.match(H.protectReason(proc(5101, 1, '/opt/keep/bin/x'), c2), /allowlist/);
    assert.equal(H.protectReason(proc(5102, 1, '/opt/other/bin/x'), c2), null);
});
test('eligibility: other users are never eligible', () => {
    assert.match(H.eligibility(proc(6000, 1, '/x/y', { uid: 0 }), ctxOf([])), /another user/);
    assert.equal(H.eligibility(proc(6001, 1, '/x/y'), ctxOf([])), null);
});

// ── PID reuse + rate limit ──
test('PID-reuse guard compares start time and command', () => {
    const live = proc(7000, 1, '/x/burn');
    assert.equal(H.identityMismatch({ startTime: live.startTime, comm: live.comm }, live), null);
    assert.match(H.identityMismatch({ startTime: live.startTime + 1000 }, live), /reused/);
    assert.match(H.identityMismatch({ startTime: live.startTime, comm: '/x/other' }, live), /reused/);
    assert.match(H.identityMismatch({ startTime: 1 }, null), /gone/);
});
test('rate limit: max per window and a per-command cooldown', () => {
    const rl = new H.RateLimiter(); const rate = { max: 3, windowMin: 10, commandCooldownMin: 30 };
    const t0 = 1e9;
    for (const n of ['a', 'b', 'c']) { assert.equal(rl.check(n, rate, t0), null); rl.record(n, t0); }
    assert.match(rl.check('d', rate, t0 + 1000), /rate limit/);
    assert.equal(rl.check('d', rate, t0 + 11 * 60000), null);
    assert.match(rl.check('a', rate, t0 + 11 * 60000), /cooldown/);
    assert.equal(rl.check('a', rate, t0 + 31 * 60000), null);
});
test('temperature trend: delta per minute and slope', () => {
    const now = 10 * 60000;
    const hist = [0, 1, 2, 3].map((i) => ({ t: now - (3 - i) * 60000, tempC: 50 + i * 2 }));
    const t = H.trendOf(hist, now);
    assert.equal(t.deltaPerMin, 2); assert.equal(t.slope10m, 2); assert.equal(t.direction, 'rising');
    assert.equal(H.trendOf([], now).direction, 'unknown');
});

test('protection: the real executable path counts, not only argv[0]', () => {
    const c = ctxOf([]);
    // a system daemon whose ps comm is a bare name
    assert.equal(H.protectReason(proc(7000, 1, 'photod'), c), null);
    assert.match(H.protectReason(proc(7000, 1, 'photod', { exe: '/System/Library/PrivateFrameworks/X.framework/Support/photod' }), c), /system path/);
    // a protected binary that renamed itself
    assert.match(H.protectReason(proc(7001, 1, 'worker', { exe: '/opt/homebrew/bin/cloudflared' }), c), /cloudflared/);
    assert.match(H.protectReason(proc(7002, 1, 'com.apple.something'), c), /system process/);
    assert.match(H.protectReason(proc(7003, 1, '/Library/Apple/System/Library/CoreServices/X.app/Contents/MacOS/X'), c), /system path/);
    // a look-alike that merely claims a protected-sounding argv is still protected (fail safe)
    assert.ok(H.protectReason(proc(7004, 1, '/tmp/x/yes', { args: 'claude --resume' }), c));
});
test('protection: agent processes in any case, codex helpers, agent-launched background jobs', () => {
    const c0 = ctxOf([]);
    assert.match(H.protectReason(proc(7100, 1, '/u/.local/share/claude/versions/2.1.0', { args: 'Claude' }), c0), /agent/);
    assert.match(H.protectReason(proc(7101, 1, '/u/.codex/packages/x/bin/codex-code-mode-host'), c0), /agent/);
    assert.match(H.protectReason(proc(7102, 1, '/Applications/Claude.app/Contents/Helpers/native-host'), c0), /protected app/);
    // a Bash-tool shell re-parented to launchd, and the tool it runs
    const sh = proc(7110, 1, '/bin/zsh', { args: '/bin/zsh -c source /u/.claude/shell-snapshots/snapshot-zsh-1.sh && eval yes' });
    const tool = proc(7111, 7110, '/usr/bin/yes');
    const tail = proc(7112, 1, 'tail', { args: 'tail -f /private/tmp/claude-501/proj/task.output' });
    const c = ctxOf([sh, tool, tail]);
    assert.match(H.protectReason(sh, c), /agent/);
    assert.match(H.protectReason(tool, c), /coding agent/);
    assert.match(H.protectReason(tail, c), /agent/);
    // an unrelated burner stays eligible
    assert.equal(H.protectReason(proc(7113, 1, '/usr/bin/yes', { args: 'yes' }), c), null);
});
test('protection: children of the frontmost app outside its bundle', () => {
    const front = proc(7200, 1, '/Applications/Browser.app/Contents/MacOS/Browser');
    const host = proc(7201, 7200, '/opt/vendor/bin/native-host');
    const c = ctxOf([front, host], { frontmost: { pid: 7200, bundlePath: '/Applications/Browser.app' } });
    assert.match(H.protectReason(host, c), /frontmost/);
});
test('sustain is wall time: extra samples inside an interval do not advance it, a long gap resets it', () => {
    const s = settings(); const d = new H.Detector();
    let t = 1_000_000; let cpuSec = 0;
    const at = (dtSec, pct = 99) => { cpuSec += pct / 100 * dtSec; t += dtSec * 1000; const p = proc(501, 1, '/usr/local/bin/burn', { cpuSec, pcpu: pct }); d.update([p], t, s); return [p, H.reasonsFor(p, s, 60, t)]; };
    at(60); at(2); at(2); at(2);              // three quick manual samples
    assert.equal(at(2)[1].length, 0);
    assert.equal(at(60)[0].track.cpuRun, 2);  // only the full interval counted
    assert.equal(at(60)[1].length, 1);       // 3rd real interval → candidate
    assert.equal(at(600)[0].track.cpuRun, 1); // monitor was off for 10 min: start over
});
test('rate limit re-checked at signal time (no burst past max)', () => {
    const r = new H.RateLimiter(); const rate = { max: 3, windowMin: 10, commandCooldownMin: 0 };
    for (let i = 0; i < 3; i++) { assert.equal(r.check('n' + i, rate, 1000), null); r.record('n' + i, 1000); }
    assert.match(r.check('n9', rate, 1000), /rate limit/);
});

// ── HTTP guard (a real server; nothing is ever signalled) ──
function freePort() { return new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
function req(port, { method = 'GET', p = '/', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: Object.assign({ host: `127.0.0.1:${port}` }, data ? { 'content-type': 'application/json' } : {}, headers) }, (res) => {
            let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
        });
        r.on('error', reject); if (data) r.write(data); r.end();
    });
}
test('HTTP guard: forged Host, forwarded headers, cross-site, missing token', async (t) => {
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-health-test-'));
    const child = spawn(process.execPath, [SCRIPT], { env: Object.assign({}, process.env, {
        SOA_HEALTH_PORT: String(port), SOA_WEB_STATE_DIR: dir, SOA_HEALTH_NO_HELPER: '1', SOA_HEALTH_NOTIFY_DRY: '1',
        SOA_HEALTH_TEST_ALLOW_PIDS: '2147483646', SOA_HEALTH_LOG: path.join(dir, 'health.log') }), stdio: 'ignore' });
    t.after(() => { child.kill('SIGTERM'); fs.rmSync(dir, { recursive: true, force: true }); });
    for (let i = 0; i < 100; i++) { try { if ((await req(port, { p: '/health' })).status === 200) break; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); }

    assert.equal((await req(port, { p: '/health' })).status, 200);
    assert.equal((await req(port, { p: '/status', headers: { host: 'evil.example:80' } })).status, 403);
    assert.equal((await req(port, { p: '/token', headers: { host: `attacker.test:${port}` } })).status, 403);
    assert.equal((await req(port, { p: '/health', headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 403);
    assert.equal((await req(port, { p: '/health', headers: { 'cf-connecting-ip': '203.0.113.9' } })).status, 403);
    assert.equal((await req(port, { p: '/status', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    // mutating without a token
    assert.equal((await req(port, { method: 'POST', p: '/settings', body: { enabled: false } })).status, 403);
    assert.equal((await req(port, { method: 'POST', p: '/terminate', body: { pid: 2147483646, startTime: 1 } })).status, 403);
    assert.equal((await req(port, { method: 'POST', p: '/settings', headers: { 'x-health-token': 'nope' }, body: { enabled: false } })).status, 403);
    // the per-install key is refused when the request looks proxied
    const key = fs.readFileSync(path.join(dir, 'health', 'key'), 'utf8').trim();
    assert.equal((await req(port, { method: 'POST', p: '/settings', headers: { authorization: `Bearer ${key}`, 'x-forwarded-for': '203.0.113.9' }, body: { enabled: false } })).status, 403);
    // a minted token works (also through the proxy), and auto needs the confirm phrase
    const tok = (await req(port, { p: '/token', headers: { 'x-forwarded-for': '203.0.113.9' } })).body.token;
    const h = { 'x-health-token': tok, 'x-forwarded-for': '203.0.113.9' };
    const off = await req(port, { method: 'POST', p: '/settings', headers: h, body: { enabled: false } });
    assert.equal(off.status, 200); assert.equal(off.body.settings.enabled, false);
    assert.equal((await req(port, { method: 'POST', p: '/settings', headers: h, body: { mode: 'auto' } })).status, 400);
    // through the daemon proxy JSON travels as text/plain (express.json() eats application/json)
    const tp = await req(port, { method: 'POST', p: '/settings', headers: Object.assign({ 'content-type': 'text/plain;charset=UTF-8' }, h), body: { intervalSec: 120 } });
    assert.equal(tp.status, 200); assert.equal(tp.body.settings.intervalSec, 120);
    assert.equal((await req(port, { method: 'POST', p: '/settings', headers: Object.assign({ 'content-type': 'application/x-www-form-urlencoded' }, h), body: { enabled: true } })).status, 403);
    // a pid outside the test allowlist is refused before anything is looked up
    const k = await req(port, { method: 'POST', p: '/terminate', headers: h, body: { pid: process.pid, startTime: 1 } });
    assert.equal(k.status, 409); assert.equal(k.body.result, 'refused');
    const mode = fs.statSync(path.join(dir, 'health', 'settings.json')).mode & 0o777;
    assert.equal(mode, 0o600);
});

// ── notification delivery: retry, dedupe, reasons ──
function fakeClock() {
    let t = 1_000_000; const q = [];
    return {
        now: () => t,
        timer: (fn, ms) => { q.push({ at: t + ms, fn }); return { unref() {} }; },
        async advance(ms) {
            t += ms;
            for (;;) {
                q.sort((a, b) => a.at - b.at);
                if (!q.length || q[0].at > t) break;
                const j = q.shift(); j.fn();
                await new Promise((r) => setImmediate(r));
            }
        },
    };
}
const flush = () => new Promise((r) => setImmediate(r));
test('notifier: a transient failure is retried with backoff and the real reason logged', async () => {
    const c = fakeClock(); const logs = []; const calls = [];
    const results = [{ ok: false, reason: 'exit 1: ntfy POST failed (HTTP 000: Could not resolve host: ntfy.sh)' }, { ok: true }];
    const n = new H.Notifier({ run: async (ch, a) => { calls.push([ch, a]); return results.shift(); }, log: (m) => logs.push(m), delays: [0, 20000, 90000], now: c.now, timer: c.timer });
    assert.equal(n.send('push', ['-t', 'x', 'hello'], { title: 'x', text: 'hello' }), 'queued');
    await flush();
    assert.equal(calls.length, 1);
    assert.match(logs.join('\n'), /attempt 1\/3 failed \(exit 1: ntfy POST failed \(HTTP 000: Could not resolve host: ntfy\.sh\)\); retry in 20 s/);
    await c.advance(19000); assert.equal(calls.length, 1);
    await c.advance(1000); assert.equal(calls.length, 2);
    assert.match(logs.join('\n'), /delivered on attempt 2\/3/);
    assert.equal(n.pending.size, 0);
});
test('notifier: gives up after the last attempt, never more than delays.length tries', async () => {
    const c = fakeClock(); const logs = []; let calls = 0;
    const n = new H.Notifier({ run: async () => { calls++; return { ok: false, reason: 'timed out' }; }, log: (m) => logs.push(m), delays: [0, 20000, 90000], now: c.now, timer: c.timer });
    n.send('push', ['a'], { title: 't', text: 'a' });
    await flush(); await c.advance(20000); await c.advance(90000); await c.advance(600000);
    assert.equal(calls, 3);
    assert.match(logs.join('\n'), /FAILED after 3 attempts: timed out/);
    assert.equal(n.pending.size, 0);
});
test('notifier: dedupe while pending and after delivery; distinct messages pass; pending is capped', async () => {
    const c = fakeClock(); let calls = 0;
    let fail = true;
    const n = new H.Notifier({ run: async () => { calls++; return { ok: !fail }; }, delays: [0, 20000], dedupeMs: 600000, maxPending: 2, now: c.now, timer: c.timer });
    assert.equal(n.send('push', ['a'], { title: 't', text: 'a' }), 'queued');
    await flush();
    assert.equal(n.send('push', ['a'], { title: 't', text: 'a' }), 'duplicate');    // same alert while its retry is pending
    assert.equal(n.send('chat', ['a'], { title: 't', text: 'a' }), 'queued');        // another channel is its own job
    assert.equal(n.send('push', ['b'], { title: 't', text: 'b' }), 'dropped');       // cap reached
    fail = false; await c.advance(20000);
    assert.equal(n.send('push', ['a'], { title: 't', text: 'a' }), 'duplicate');    // delivered moments ago
    await c.advance(600001);
    assert.equal(n.send('push', ['a'], { title: 't', text: 'a' }), 'queued');       // after the window it is a new alert
    await flush();
    assert.equal(calls, 5);
});
test('notifier: a sender that throws is a failed attempt, not a crash', async () => {
    const c = fakeClock(); const logs = [];
    const n = new H.Notifier({ run: async () => { throw new Error('spawn ENOENT'); }, log: (m) => logs.push(m), delays: [0], now: c.now, timer: c.timer });
    n.send('chat', ['x'], { text: 'x' }); await flush();
    assert.match(logs.join('\n'), /FAILED after 1 attempts: spawn ENOENT/);
});
test('failure reason: stderr preferred, topic URL redacted, timeouts named', () => {
    const e = Object.assign(new Error('Command failed: soa-notify -t x --click https://h/preview/6084/confirm?c=abc body'), { code: 1 });
    const r = H.failureReason(e, 'soa-notify: ntfy POST failed (HTTP 000: Could not resolve host: ntfy.sh) → https://ntfy.sh/secret-topic-123\n');
    assert.equal(r, 'exit 1: soa-notify: ntfy POST failed (HTTP 000: Could not resolve host: ntfy.sh)');
    assert.ok(!r.includes('secret-topic'));
    const t = H.failureReason(Object.assign(new Error('Command failed: x'), { killed: true, signal: 'SIGTERM' }), '');
    assert.match(t, /^timed out/);
    assert.ok(!H.failureReason(e, '').includes('https://'));
});

// ── the link a push opens ──
test('deep link: the companion with the alert id, display details, never a token', () => {
    const c = { pid: 41332, startTime: 1, app: 'Google Chrome', name: 'Google Chrome Helper', reasons: [{ detail: 'memory grew +1228 MB in 11 min' }] };
    const u = new URL(H.healthDeepLink('https://www.s0a.app/', 'DX_qbQDJO0Zz', c));
    assert.equal(u.origin + u.pathname, 'https://www.s0a.app/m/');
    assert.equal(u.search, '');
    const q = new URLSearchParams(u.hash.slice(1));
    assert.equal(q.get('health'), 'DX_qbQDJO0Zz'); assert.equal(q.get('pid'), '41332');
    assert.equal(q.get('name'), 'Google Chrome'); assert.equal(q.get('why'), 'memory grew +1228 MB in 11 min');
    assert.ok(!q.has('t') && !q.has('u') && !q.has('token'));
    assert.ok(H.healthDeepLink('https://x', 'id1', { pid: 2, name: 'n', reasons: [{ detail: 'z'.repeat(500) }] }).length < 260);
});

// ── cross-site through the daemon proxy ──
function fakeReq(headers, method = 'GET') { return { method, headers: Object.assign({ host: '127.0.0.1:6084' }, headers), socket: { remoteAddress: '127.0.0.1' } }; }
test('guard: cross-site is accepted only from the public front end AND through a forwarding proxy', () => {
    const fwd = { 'x-forwarded-for': '203.0.113.9' };
    const xs = { 'sec-fetch-site': 'cross-site' };
    assert.equal(H.guardReason(fakeReq({ ...xs, ...fwd, origin: 'https://www.s0a.app' }), 6084), null);
    assert.equal(H.guardReason(fakeReq({ ...xs, ...fwd, origin: 'https://s0a.app' }, 'POST'), 6084), null);
    assert.equal(H.guardReason(fakeReq({ ...xs, 'cf-connecting-ip': '1.2.3.4', origin: 'https://www.s0a.app' }, 'POST'), 6084), null);
    // not proxied: a page on the Mac itself talking to the port directly
    assert.equal(H.guardReason(fakeReq({ ...xs, origin: 'https://www.s0a.app' }), 6084), 'cross-site request');
    // proxied but another origin, a look-alike, or none
    assert.equal(H.guardReason(fakeReq({ ...xs, ...fwd, origin: 'https://evil.example' }), 6084), 'cross-site request');
    assert.equal(H.guardReason(fakeReq({ ...xs, ...fwd, origin: 'https://www.s0a.app.evil.example' }), 6084), 'cross-site request');
    assert.equal(H.guardReason(fakeReq({ ...xs, ...fwd, origin: 'http://www.s0a.app' }), 6084), 'cross-site request');
    assert.equal(H.guardReason(fakeReq({ ...xs, ...fwd }), 6084), 'cross-site request');
    assert.equal(H.guardReason(fakeReq({ 'sec-fetch-site': 'same-site', ...fwd, origin: 'https://evil.s0a.app' }, 'POST'), 6084), 'cross-site request');
    // the other gates still apply
    assert.equal(H.guardReason(fakeReq({ ...xs, ...fwd, origin: 'https://www.s0a.app', host: 'evil:6084' }), 6084), 'bad host');
    // a proxy header the daemon does NOT treat as remote (so its /preview gate let a
    // loopback caller through as local, no token) does not open the cross-site path
    for (const k of ['via', 'cf-ray', 'x-forwarded-proto', 'x-forwarded-host', 'x-soa-local-key', 'true-client-ip', 'x-original-url']) {
        assert.equal(H.guardReason(fakeReq({ ...xs, [k]: '1', origin: 'https://www.s0a.app' }), 6084), 'cross-site request', k);
    }
});

test('companion: parseHealthLink reads the push link; healthLinkHash round-trips; junk is ignored', async () => {
    const m = await import(path.join(__dirname, '..', '..', 'web', 'public', 'm', 'health.js'));
    const link = new URL(H.healthDeepLink('https://www.s0a.app', 'DX_qbQDJO0Zz', { pid: 41332, app: 'Google Chrome', reasons: [{ detail: 'memory grew' }] }));
    const f = m.parseHealthLink(link.hash);
    assert.deepEqual(f, { id: 'DX_qbQDJO0Zz', pid: 41332, name: 'Google Chrome', why: 'memory grew' });
    assert.deepEqual(m.parseHealthLink(m.healthLinkHash(f)), f);
    assert.equal(m.parseHealthLink('#view=chat'), null);
    assert.equal(m.parseHealthLink('#health=<script>'), null);
    assert.equal(m.parseHealthLink(''), null);
    assert.equal(m.parseHealthLink('#health=abcd&pid=1').pid, null);
});
