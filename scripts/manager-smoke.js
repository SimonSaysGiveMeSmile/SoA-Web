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
 * The final section (the human-facing /api/meetings REST surface) is the one
 * exception: it BOOTS ITS OWN daemon on an OS-assigned free port with its own
 * temp state dir, and tears both down. That surface is cookie-authed and
 * manager-entitled, so it needs SOA_WEB_MANAGER_ENABLED=1 — which is not
 * something to switch on inside somebody else's daemon.
 *
 * Exits 0 if every assertion passes, 1 otherwise.
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const WebSocket = require(path.resolve(__dirname, '../node_modules/ws'));

const HOST = process.env.SMOKE_HOST || '127.0.0.1';
const PORT = Number(process.env.SOA_WEB_PORT || process.env.SMOKE_PORT || 7700);
// The real fleet's daemon. Hard-coded as a REFUSAL, not as a default: driving
// the meetings section against the live daemon would open real rooms in real
// terminals and type real prompts into whatever is running there.
const LIVE_PORT = 4010;

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

// A request to an ARBITRARY method/path/port. `api()` above is hard-wired to
// POST /api/sessions; the meetings REST routes are GETs and POSTs on their own
// paths, against the throwaway daemon this script boots for them.
function rest(port, method, p, body) {
    return new Promise((resolve) => {
        const data = body == null ? null : JSON.stringify(body);
        const req = http.request({
            host: HOST, port, path: p, method,
            headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
        }, (res) => {
            let buf = '';
            res.on('data', (c) => (buf += c));
            res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, json: j, raw: buf }); });
        });
        req.on('error', (e) => resolve({ status: 0, json: null, error: e.message }));
        if (data) req.write(data);
        req.end();
    });
}

// Let the OS name a port nobody is using, so this never collides with the
// developer's own daemon (or with the one this script is already pointed at).
function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.on('error', reject);
        s.listen(0, HOST, () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}

/**
 * Boot a private daemon and resolve once it reports the port it actually bound.
 * Reading the port back out of stdout matters: index.js HOPS to the next port on
 * EADDRINUSE, so assuming the requested one is how a smoke ends up silently
 * talking to whatever else is listening.
 */
function bootDaemon(port, stateDir) {
    return new Promise((resolve, reject) => {
        const env = {
            ...process.env,
            SOA_WEB_PORT: String(port),
            SOA_WEB_HOST: HOST,
            SOA_WEB_STATE_DIR: stateDir,     // own state dir → own instance lock, own tabs.json
            SOA_WEB_MANAGER_ENABLED: '1',    // /api/meetings is manager-entitled
            SOA_WEB_AUTOPAIR: '0',           // no tunnel: a smoke must not expose a shell
            SOA_WEB_NO_AUTO_RESUME: '1',     // no `claude --resume` into the mock tabs
        };
        // SOA_BUS_DIR outranks SOA_WEB_STATE_DIR in meetStore's resolution chain,
        // so inheriting it would write this smoke's fake rooms into the real
        // fleet's shared bus — visible in `soa-bus channels` forever after.
        delete env.SOA_BUS_DIR;
        const proc = spawn(process.execPath, [path.resolve(__dirname, '../server/src/index.js')], {
            env, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let log = '';
        let settled = false;
        const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
        const scan = (chunk) => {
            log += chunk.toString();
            const m = /SoA-Web ready: http:\/\/[^:\s]+:(\d+)/.exec(log);
            if (m) finish(resolve, { proc, port: Number(m[1]), log: () => log });
        };
        proc.stdout.on('data', scan);
        proc.stderr.on('data', scan);
        proc.on('exit', (code) => finish(reject, new Error(`daemon exited (${code}) before it was ready: ${log.slice(-400)}`)));
        proc.on('error', (e) => finish(reject, e));
        const t = setTimeout(() => finish(reject, new Error(`daemon never reported ready: ${log.slice(-400)}`)), 25_000);
        if (t.unref) t.unref();
    });
}

// Hold a WS open for a whole section: it OWNS the mock tabs (a session with no
// tabs is the one resolveSession() falls back away from) and it receives the
// pushed frames.
function connect(port, nTabs) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${HOST}:${port}/ws`);
        const frames = [];
        let ids = [];
        ws.on('open', () => { for (let i = 0; i < nTabs; i++) ws.send(JSON.stringify({ v: 1, t: 'input', d: { kind: 'new-tab', cols: 80, rows: 24 } })); });
        ws.on('message', (raw) => {
            let m; try { m = JSON.parse(raw.toString()); } catch { return; }
            frames.push(m);
            if (m.t === 'snapshot' && m.d && Array.isArray(m.d.tabs)) ids = m.d.tabs.map((t) => t.id);
        });
        ws.on('error', reject);
        setTimeout(() => resolve({ ws, frames, ids: () => ids }), 2500);
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
    // This script SPAWNS and STOPS tabs and fans a goal out to `all`. It picks
    // its target up from the ambient SOA_WEB_PORT, which on a developer machine
    // is exported and points at the REAL fleet — so a bare `node
    // scripts/manager-smoke.js` in a normal shell drives production. Refuse.
    // (Observed: two orphan mock tabs opened in the live daemon that way.)
    if (PORT === LIVE_PORT) {
        console.error(`refusing to smoke :${LIVE_PORT} — that is the live fleet, and this script spawns and stops tabs.\n` +
            `Start an isolated daemon and target it explicitly: SOA_WEB_PORT=7700 node scripts/manager-smoke.js (see header).`);
        process.exit(2);
    }
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

    // ── group meetings over the loopback action surface ──────────────────────
    // The daemon is the SINGLE writer of a room's transcript, so the roster
    // resolution, the IM cap and the refusal codes all have to hold HERE, over
    // real HTTP — the unit tests cover the same rules against fake tabs.
    const mtab = await api({ action: 'spawn', claude: false, title: 'smoke-meet-3' });
    const E = mtab.json && mtab.json.id;
    const ROOM = 'smoke-standup';
    const ms = await api({ action: 'meet-start', room: ROOM, with: [A, B, E], self: A, title: 'smoke standup' });
    const members = (ms.json && ms.json.room && ms.json.room.members) || [];
    const mids = members.map((m) => m.id);
    ok('meet-start reports the RESOLVED id list',
        ms.status === 200 && mids.length === 2 && mids.includes(B) && mids.includes(E) && members.every((m) => m.resolved === 'id'),
        JSON.stringify(ms.json));
    // A convener runs the meeting, it does not sit in it — otherwise the manager
    // agent prompts itself in a loop.
    ok('meet-start EXCLUDES the caller\'s own tab', !mids.includes(A), `members=${JSON.stringify(mids)}`);

    const nobody = await api({ action: 'meet-start', room: 'smoke-nobody', with: 'nonsense-cohort' });
    const rooms = await api({ action: 'meet-list' });
    ok('unknown selector convenes ZERO members (no accidental fleet-wide meeting)',
        nobody.status === 400 && !((rooms.json && rooms.json.rooms) || []).some((r) => r.room === 'smoke-nobody'),
        JSON.stringify(nobody.json));

    // A member is not a claim: sharing the daemon's cwd with a member must not be
    // enough to speak in the room (siblings in one directory are distinct agents).
    const intruder = await api({ action: 'meet-say', room: ROOM, self: A, text: 'butting in' });
    ok('a non-member cannot speak in the room (409 NOT_MEMBER)',
        intruder.status === 409 && intruder.json && intruder.json.code === 'NOT_MEMBER', JSON.stringify(intruder.json));

    // IM discipline: an agent that over-explains still gets heard, just trimmed.
    // Rejecting the line would strand the agent with no way to answer at all.
    const longText = 'sentence ' + 'x'.repeat(600);
    const said = await api({ action: 'meet-say', room: ROOM, self: B, text: longText });
    const text = (said.json && said.json.msg && said.json.msg.text) || '';
    ok('over-cap text is TRUNCATED, not rejected',
        said.status === 200 && said.json.ok === true && [...text].length < [...longText].length && text.endsWith('…'),
        `status=${said.status} len=${[...text].length}`);

    const ended = await api({ action: 'meet-end', room: ROOM, why: 'smoke' });
    ok('meet-end adjourns the room', ended.status === 200 && ended.json && ended.json.room && ended.json.room.open === false);
    // A 409 (not a 500, not a silent 200) is what lets the CLI exit 3 and the UI
    // render "this meeting has adjourned".
    const afterClose = await api({ action: 'meet-say', room: ROOM, self: B, text: 'anyone still here?' });
    ok('a CLOSED room refuses new lines with 409 ROOM_CLOSED',
        afterClose.status === 409 && afterClose.json && afterClose.json.code === 'ROOM_CLOSED', JSON.stringify(afterClose.json));
    if (Number.isInteger(E)) await api({ action: 'stop', id: E, force: true });

    const bad = await api({ action: 'frobnicate' });
    ok('unknown action → 400', bad.status === 400);

    // cleanup our fresh tabs (no self → allowed)
    for (const id of mine) await api({ action: 'stop', id });

    await meetingsRest();

    console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('smoke crashed:', e && e.message); process.exit(1); });

// ── the human-facing REST surface (server/src/meetings.js) ──────────────────
// This is the surface the browser and the paired phone actually drive — the one
// the user's own messages go through — and it had no automated coverage at all:
// the unit tests stop at sessionManager, and the loopback section above only
// exercises the AGENT half (/api/sessions meet-*). Everything here runs against
// a daemon this function boots and kills itself, because the routes are
// manager-entitled and enabling that inside somebody else's daemon is not this
// script's business.
async function meetingsRest() {
    console.log('\n  ── /api/meetings (own throwaway daemon) ──');
    const want = await freePort();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-meet-smoke-'));
    let boot = null;
    let ws = null;
    try {
        boot = await bootDaemon(want, stateDir);
        const P = boot.port;
        // The refusal, restated after boot: index.js hops ports on EADDRINUSE, so
        // the port we asked for and the port we got are not the same fact.
        if (P === LIVE_PORT || P === PORT) {
            ok('meetings REST: bound an ISOLATED port', false, `refusing to drive :${P} — that is the live daemon / the one this smoke was pointed at`);
            return;
        }
        ok('meetings REST: booted a private daemon on a free port', P > 0 && P !== LIVE_PORT, `:${P} state=${stateDir}`);

        const R = (method, p, body) => rest(P, method, p, body);
        const conn = await connect(P, 3);
        ws = conn.ws;
        const tabs = conn.ids();
        ok('meetings REST: opened 3 mock tabs over WS', tabs.length === 3, `ids=${tabs.join(',')}`);
        if (tabs.length < 2) return;

        // ── the payload the participant picker opens with ──
        // rooms AND candidates in ONE response, deliberately: a picker that
        // fetched /api/meetings and /api/manager separately races them, and shows
        // a roster of agents that no longer matches the room list beside it.
        let r = await R('GET', '/api/meetings');
        ok('GET /api/meetings serves rooms AND candidates in one response',
            r.status === 200 && r.json && r.json.ok === true && Array.isArray(r.json.rooms) && Array.isArray(r.json.candidates) && r.json.candidates.length >= 3,
            `${r.status} rooms=${(r.json && r.json.rooms || []).length} candidates=${(r.json && r.json.candidates || []).length}`);
        const cand = (r.json && r.json.candidates || [])[0] || {};
        ok('GET /api/meetings candidates carry every picker field',
            ['id', 'title', 'cwd', 'group', 'status', 'ctxPct', 'lifecycle', 'meeting'].every((k) => k in cand),
            Object.keys(cand).join(','));

        // ── convene ──
        const ROOM = 'rest-standup';
        r = await R('POST', '/api/meetings', { op: 'start', room: ROOM, title: 'ship or wait?', members: [{ id: tabs[0] }, { id: tabs[1] }] });
        const view = (r.json && r.json.room) || {};
        ok('POST /api/meetings {op:start} opens a room with a RESOLVED roster',
            r.status === 200 && r.json.ok === true && view.open === true && (view.members || []).length === 2 && (view.members || []).every((m) => m.id != null && m.resolved === 'id'),
            `${r.status} ${(view.members || []).map((m) => `#${m.id}/${m.resolved}`).join(' ')} ${(r.json && r.json.error) || ''}`);
        ok('POST start exposes the budgets the UI renders as meters',
            typeof view.relayMax === 'number' && typeof view.msgBudget === 'number' && typeof view.mode === 'string',
            `mode=${view.mode} relay ${view.relayHops}/${view.relayMax} msgs=${view.msgBudget}`);

        // ── the human's turn: ONE post, never a fan-out into N terminals ──
        conn.frames.length = 0;
        r = await R('POST', `/api/meetings/${ROOM}/say`, { text: 'Ship today or wait for the CSS fix?' });
        const msg = (r.json && r.json.msg) || {};
        ok('POST /api/meetings/:room/say records the human turn',
            r.status === 200 && r.json.ok === true && typeof r.json.seq === 'number' && r.json.roomView && r.json.roomView.open === true,
            `${r.status} seq=${r.json && r.json.seq}`);
        ok('say echoes a contract-shaped <msg> (who is the STRING "user")',
            msg.who === 'user' && typeof msg.who === 'string' && msg.from === 'you (manager)' && typeof msg.seq === 'number' && msg.via === 'user',
            JSON.stringify(msg));
        await new Promise((res) => setTimeout(res, 400));
        const pushed = conn.frames.filter((f) => f.t === 'meeting');
        // The 3s manager snapshot carries the roster but not the lines, so this
        // frame is the whole reason a meeting reads as a chat and not as a log.
        ok('a t:"meeting" frame is pushed over WS immediately, as {room, msgs}',
            pushed.length >= 1 && pushed[0].d && pushed[0].d.room === ROOM && Array.isArray(pushed[0].d.msgs) && pushed[0].d.msgs.length === 1,
            `${pushed.length} frames ${JSON.stringify(pushed[0] && pushed[0].d)}`);

        // ── the paging the UI uses on entry, then on every reconnect ──
        r = await R('GET', `/api/meetings/${ROOM}?since=0`);
        const msgs = (r.json && r.json.msgs) || [];
        const cursor = r.json && r.json.cursor;
        ok('GET /api/meetings/:room?since=0 returns the transcript plus a cursor',
            r.status === 200 && msgs.length === 1 && cursor === msgs[msgs.length - 1].seq && r.json.room && r.json.room.room === ROOM,
            `${r.status} ${msgs.length} msgs cursor=${cursor}`);
        r = await R('GET', `/api/meetings/${ROOM}?since=${cursor}`);
        // `since` is EXCLUSIVE and the cursor is the max seq SEEN. If a re-read at
        // the returned cursor replayed even one line, every reconnect would
        // duplicate the tail of the transcript in the client.
        ok('paging: a second read at the returned cursor yields ZERO msgs',
            r.status === 200 && (r.json.msgs || []).length === 0 && r.json.cursor === cursor,
            `${(r.json && r.json.msgs || []).length} msgs cursor=${r.json && r.json.cursor}`);

        // ── an unknown room is a 404, not an empty 200 ──
        // An empty 200 would render as a real, silent, permanently-quiet room.
        r = await R('GET', '/api/meetings/rest-no-such-room');
        ok('GET an unknown room → 404', r.status === 404 && r.json && r.json.ok === false, `${r.status} ${r.raw && r.raw.slice(0, 80)}`);
        r = await R('POST', '/api/meetings/rest-no-such-room/say', { text: 'hello?' });
        ok('say into an unknown room → 404 (NO_ROOM)', r.status === 404 && r.json && r.json.code === 'NO_ROOM', `${r.status} ${r.json && r.json.code}`);

        // ── adjourn, then the 409 that must render as a sentence ──
        r = await R('POST', '/api/meetings', { op: 'end', room: ROOM, why: 'smoke' });
        ok('POST {op:end} adjourns the room', r.status === 200 && r.json.room && r.json.room.open === false && r.json.room.closedWhy === 'smoke',
            `${r.status} ${r.json && r.json.room && r.json.room.closedWhy}`);
        r = await R('POST', `/api/meetings/${ROOM}/say`, { text: 'anyone still here?' });
        // A 409 WITH its code is the contract: the client turns ROOM_CLOSED into
        // "this meeting has adjourned". A bare 500 (or a silent 200) is what makes
        // the user retype the same message into a room that ended.
        ok('an ADJOURNED room refuses the human turn with 409 ROOM_CLOSED',
            r.status === 409 && r.json && r.json.code === 'ROOM_CLOSED' && r.json.ok === false,
            `${r.status} ${r.json && r.json.code}`);
        r = await R('GET', `/api/meetings/${ROOM}?since=0`);
        ok('the transcript survives adjournment, with the reason recorded IN it',
            r.status === 200 && (r.json.msgs || []).some((m) => m.who === 'system' && /adjourned/.test(m.text)),
            (r.json && r.json.msgs || []).map((m) => m.who).join(','));
    } catch (e) {
        ok('meetings REST section ran', false, (e && e.message) || String(e));
    } finally {
        try { if (ws) ws.close(); } catch (_) {}
        if (boot && boot.proc) { try { boot.proc.kill('SIGTERM'); } catch (_) {} }
        // The daemon owns real PTYs; give it a moment to reap them before the
        // state dir (and its instance lock) go away underneath it.
        await new Promise((res) => setTimeout(res, 500));
        if (boot && boot.proc) { try { boot.proc.kill('SIGKILL'); } catch (_) {} }
        try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
    }
}
