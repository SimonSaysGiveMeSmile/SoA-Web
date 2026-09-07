#!/usr/bin/env node
/**
 * manager-smoke.js — end-to-end smoke of the manager-agent loopback surface
 * (/api/sessions) against an ISOLATED daemon. No Claude: it opens plain mock
 * shell tabs over WS, then exercises the action surface and asserts the
 * critical invariants (self-exclusion, self-stop refusal, event ring, long-poll).
 *
 * It NEVER touches the production fleet — point it at a throwaway daemon:
 *
 *   SOA_WEB_PORT=7700 SOA_WEB_STATE_DIR=~/.soa-web-mgrtest SOA_WEB_HOST=127.0.0.1 \
 *   SOA_WEB_AUTOPAIR=0 SOA_WEB_NO_AUTO_RESUME=1 node server/src/index.js &
 *   node scripts/manager-smoke.js            # defaults to :7700
 *
 * Exits 0 if every assertion passes, 1 otherwise.
 */
const http = require('http');
const path = require('path');
const WebSocket = require(path.resolve(__dirname, '../node_modules/ws'));

const HOST = process.env.SMOKE_HOST || '127.0.0.1';
const PORT = Number(process.env.SOA_WEB_PORT || process.env.SMOKE_PORT || 7700);

let passed = 0, failed = 0;
function ok(name, cond, detail) {
    if (cond) { passed++; console.log(`  ✔ ${name}`); }
    else { failed++; console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
}

function api(body) {
    return new Promise((resolve) => {
        const data = JSON.stringify(body);
        const req = http.request({
            host: HOST, port: PORT, path: '/api/sessions', method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
        }, (res) => {
            let buf = '';
            res.on('data', (c) => (buf += c));
            res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
        });
        req.on('error', (e) => resolve({ status: 0, json: null, error: e.message }));
        req.write(data); req.end();
    });
}

function openTabs(n) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${HOST}:${PORT}/ws`);
        const ids = new Set();
        ws.on('open', () => { for (let i = 0; i < n; i++) ws.send(JSON.stringify({ v: 1, t: 'input', d: { kind: 'new-tab', cols: 80, rows: 24 } })); });
        ws.on('message', (raw) => {
            let m; try { m = JSON.parse(raw.toString()); } catch { return; }
            if (m.t === 'snapshot' && m.d && Array.isArray(m.d.tabs)) m.d.tabs.forEach((t) => ids.add(t.id));
        });
        ws.on('error', reject);
        setTimeout(() => { ws.close(); resolve([...ids]); }, 2500);
    });
}

(async () => {
    console.log(`manager-smoke → ${HOST}:${PORT}`);
    const ping = await new Promise((r) => http.get(`http://${HOST}:${PORT}/api/ping`, (res) => r(res.statusCode === 200)).on('error', () => r(false)));
    if (!ping) { console.error(`no daemon on :${PORT} — start an isolated one first (see header)`); process.exit(2); }

    const before = new Set((await openTabs(0)) || []); // existing tabs (don't touch)
    await openTabs(2);
    const list = await api({ action: 'list' });
    const allIds = (list.json && list.json.sessions || []).map((s) => s.id);
    const mine = allIds.filter((id) => !before.has(id));
    ok('bootstrap: opened ≥2 fresh mock tabs', mine.length >= 2, `mine=${JSON.stringify(mine)}`);
    const [A, B] = mine;

    const who = await api({ action: 'whoami', self: A });
    ok('whoami echoes own tab', who.json && who.json.self === A);

    const goal = await api({ action: 'goal', verb: 'goal', id: 'all', self: A, text: 'x' });
    const gt = (goal.json && goal.json.targets || []).map((t) => t.id);
    ok('goal id=all EXCLUDES self', !gt.includes(A) && gt.includes(B), `targets=${JSON.stringify(gt)}`);

    const bc = await api({ action: 'broadcast', to: 'all', self: A, text: 'x' });
    ok('broadcast to=all EXCLUDES self', bc.json && !bc.json.ids.includes(A));

    const schAll = await api({ action: 'schedule', id: 'all', at: '+99m', text: 'continue', self: A });
    ok('schedule id=all EXCLUDES self', schAll.json && !(schAll.json.scheduled || []).some((s) => s.tabId === A));
    const schSelf = await api({ action: 'schedule', id: A, at: '+99m', text: 'continue', self: A });
    ok('schedule into your OWN id is refused (400)', schSelf.status === 400);
    await api({ action: 'unschedule', scheduleId: '' }); // (cleanup no-op; schedules are +99m anyway)

    const unknownSel = await api({ action: 'goal', verb: 'goal', id: 'nonsense-cohort', self: A, text: 'x' });
    ok('unknown cohort resolves to ZERO targets (no accidental fleet-wide fan-out)', unknownSel.json && unknownSel.json.count === 0);

    // Watch long-poll: test the TIMEOUT path while the fleet is quiescent (before
    // any spawn/stop, whose async PTY exit events would otherwise wake the park).
    // Drain to head first so the cursor reflects every event emitted so far.
    const head = (await api({ action: 'events', since: 0 })).json.cursor;
    const watch = await api({ action: 'watch', cursor: head, timeoutMs: 1200 });
    ok('watch long-poll times out cleanly', watch.json && watch.json.timedOut === true, JSON.stringify(watch.json));

    // Watch WAKE path: park a watch, fire an event while it's parked, assert it
    // returns the event (not a timeout) — the core of the manager event loop.
    const head2 = (await api({ action: 'events', since: 0 })).json.cursor;
    const wakeP = api({ action: 'watch', cursor: head2, timeoutMs: 6000 });
    await new Promise((r) => setTimeout(r, 300)); // let the watch park before the event
    const wk = await api({ action: 'spawn', claude: false, title: 'smoke-watch-wake' });
    const D = wk.json && wk.json.id;
    const woke = await wakeP;
    ok('watch WAKES on a new event (not just timeout)',
        woke.json && woke.json.timedOut === false && (woke.json.events || []).some((e) => e.id === D && e.kind === 'spawned'),
        JSON.stringify(woke.json));
    if (Number.isInteger(D)) await api({ action: 'stop', id: D });

    const spawn = await api({ action: 'spawn', claude: false, title: 'smoke-spawn' });
    const C = spawn.json && spawn.json.id;
    ok('spawn (claude:false) creates a tab', Number.isInteger(C));
    const evs = await api({ action: 'events', since: 0 });
    ok('spawn emits a "spawned" event', evs.json && evs.json.events.some((e) => e.kind === 'spawned' && e.id === C));

    const selfStop = await api({ action: 'stop', id: A, self: A });
    ok('stop refuses your OWN tab (400)', selfStop.status === 400);

    const stopC = await api({ action: 'stop', id: C, self: A });
    ok('stop closes another tab', stopC.json && stopC.json.closed === true);

    const read = await api({ action: 'read', id: A, lines: 10 });
    ok('read returns a tab view', read.json && read.json.id === A && typeof read.json.text === 'string');

    const bad = await api({ action: 'frobnicate' });
    ok('unknown action → 400', bad.status === 400);

    // cleanup our fresh tabs (no self → allowed)
    for (const id of mine) await api({ action: 'stop', id });

    console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('smoke crashed:', e && e.message); process.exit(1); });
