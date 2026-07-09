#!/usr/bin/env node
/**
 * Repro + regression tests for the fleet-loss-on-restart clobber (2026-06-29,
 * 2026-07-08). Two layers:
 *
 *   UNIT — tabPersist's shrink guard. Persistence is last-writer-wins across
 *   sessions, so a client that binds right after boot with 1-2 fresh tabs used
 *   to persist its tiny list over the 26-tab tabs.json (the July 8 loss: the
 *   phone connected within 4s of boot, boot-resume was skipped, and ~90s later
 *   the 2-tab state clobbered the fleet). The guard must refuse an early
 *   drastic shrink unless explicit user closes account for it — while letting
 *   normal churn, genuine mass-closes, and post-window writes through.
 *
 *   INTEGRATION — boots the real server against a seeded state dir and proves
 *   (a) headless boot-resume still self-connects and rehydrates, and (b) an
 *   early client that opens its OWN tab no longer cancels rehydration: the
 *   saved tabs restore into its session alongside the new tab and tabs.json
 *   never shrinks.
 *
 * Run: node server/test/tab-clobber-guard.js
 * Each scenario runs in a child process so tabPersist's module state
 * (_bootAt, _liveTabsSeen, close counter) starts fresh every time.
 */
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const TAB_PERSIST = path.join(ROOT, 'server', 'src', 'tabPersist.js');
const SERVER = path.join(ROOT, 'server', 'src', 'index.js');

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? '  · ' + detail : ''}`);
    if (!ok) failures++;
};

const mkTabs = (n) => Array.from({ length: n }, (_, i) => ({ title: null, cwd: '/tmp', userRenamed: false }));

function tmpState({ tabs, scrollTabs } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-clobber-'));
    if (tabs) {
        fs.writeFileSync(path.join(dir, 'tabs.json'),
            JSON.stringify({ savedAt: new Date().toISOString(), tabs }, null, 2) + '\n');
    }
    if (scrollTabs) {
        fs.writeFileSync(path.join(dir, 'scrollback.json'),
            JSON.stringify({ savedAt: new Date().toISOString(), tabs: scrollTabs }) + '\n');
    }
    return dir;
}

const readTabs = (dir) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'tabs.json'), 'utf8')).tabs.length; }
    catch (_) { return null; }
};
const readScroll = (dir) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'scrollback.json'), 'utf8')).tabs.length; }
    catch (_) { return null; }
};

// Run a snippet against tabPersist in a fresh child process.
function unit(dir, guardMs, body) {
    const script = `
        const tp = require(${JSON.stringify(TAB_PERSIST)});
        const mk = (n) => ({
            order: Array.from({length: n}, (_, i) => i + 1),
            tabs: new Map(Array.from({length: n}, (_, i) => [i + 1,
                { title: 't' + (i + 1), cwd: '/tmp', userRenamed: false, scrollback: { snapshot: () => 'bytes' } }])),
        });
        ${body}
    `;
    return spawnSync(process.execPath, ['-e', script], {
        env: { ...process.env, SOA_WEB_STATE_DIR: dir, SOA_WEB_TAB_SHRINK_GUARD_MS: String(guardMs) },
        encoding: 'utf8', timeout: 15000,
    });
}

// ── UNIT: shrink guard ────────────────────────────────────────────────────

{   // 1. Early drastic shrink with no user closes → refused.
    const dir = tmpState({ tabs: mkTabs(26) });
    const r = unit(dir, 600000, `tp.saveImmediate(mk(2));`);
    check('early 26→2 shrink refused', readTabs(dir) === 26, `file has ${readTabs(dir)}; log: ${(r.stdout || '').trim()}`);
}
{   // 2. Same shrink but the user explicitly closed 24 tabs → allowed.
    const dir = tmpState({ tabs: mkTabs(26) });
    unit(dir, 600000, `for (let i = 0; i < 24; i++) tp.noteUserClose(); tp.saveImmediate(mk(2));`);
    check('26→2 with 24 user closes allowed', readTabs(dir) === 2, `file has ${readTabs(dir)}`);
}
{   // 3. Moderate shrink (still ≥ half) is normal churn → allowed.
    const dir = tmpState({ tabs: mkTabs(26) });
    unit(dir, 600000, `tp.saveImmediate(mk(20));`);
    check('26→20 (≥ half) allowed', readTabs(dir) === 20, `file has ${readTabs(dir)}`);
}
{   // 4. Outside the guard window the same write goes through.
    const dir = tmpState({ tabs: mkTabs(26) });
    unit(dir, 1, `setTimeout(() => tp.saveImmediate(mk(2)), 25);`);
    check('26→2 after window allowed', readTabs(dir) === 2, `file has ${readTabs(dir)}`);
}
{   // 5. Empty write over a saved fleet → refused (shrink + legacy guards).
    const dir = tmpState({ tabs: mkTabs(26) });
    unit(dir, 600000, `tp.saveImmediate(mk(0));`);
    check('early 26→0 refused', readTabs(dir) === 26, `file has ${readTabs(dir)}`);
}
{   // 6. Growth is always fine.
    const dir = tmpState({ tabs: mkTabs(2) });
    unit(dir, 600000, `tp.saveImmediate(mk(5));`);
    check('2→5 growth allowed', readTabs(dir) === 5, `file has ${readTabs(dir)}`);
}
{   // 7. scrollback.json (the recovery source) gets the same protection.
    const dir = tmpState({
        tabs: mkTabs(26),
        scrollTabs: mkTabs(26).map(t => ({ ...t, title: 'x', scrollback: 'bytes' })),
    });
    const r = unit(dir, 600000, `tp.saveAll(mk(2));`);
    check('scrollback 26→2 shrink refused', readScroll(dir) === 26, `file has ${readScroll(dir)}`);
    check('tabs.json also survived saveAll', readTabs(dir) === 26, `file has ${readTabs(dir)}; log: ${(r.stdout || '').trim()}`);
}

// ── INTEGRATION: real server boot ─────────────────────────────────────────

const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));

function bootServer(dir, port) {
    const child = spawn(process.execPath, [SERVER], {
        env: {
            ...process.env,
            SOA_WEB_STATE_DIR: dir,
            SOA_WEB_PORT: String(port),
            SOA_WEB_HOST: '127.0.0.1',
            SOA_WEB_AUTOPAIR: '0',
            SOA_WEB_MANAGE_TUNNEL: '0',
            SOA_WEB_NO_AUTO_RESUME: '1',           // never touch real claude sessions
            SOA_WEB_BOOT_RESUME_DELAY_MS: '1200',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });
    return { child, log: () => log };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    // A. Headless boot: nobody connects — boot-resume must self-connect and
    //    rehydrate; tabs.json must be intact afterwards.
    {
        const dir = tmpState({ tabs: mkTabs(3) });
        const srv = bootServer(dir, 7713);
        await sleep(4500);
        const log = srv.log();
        check('headless: boot-resume fired', /boot-resume\[1\/3\]: fleet not rehydrated/.test(log), 'no boot-resume line in log');
        check('headless: fleet rehydrated', /restore-on-connect: rehydrated 3\/3/.test(log), log.split('\n').filter(l => /boot-resume|restore/.test(l)).join(' | '));
        await sleep(1500);
        check('headless: tabs.json intact', (readTabs(dir) || 0) >= 3, `file has ${readTabs(dir)}`);
        srv.child.kill('SIGKILL');
    }

    // B. The July-8 race: a client connects BEFORE boot-resume and opens its
    //    own tab. Old behavior: rehydration cancelled, 1-tab list clobbers
    //    the fleet. New behavior: restore merges around the client's tab,
    //    boot-resume reports the restore already ran, file never shrinks.
    {
        const dir = tmpState({ tabs: mkTabs(3) });
        const srv = bootServer(dir, 7714);
        await sleep(400);                                     // beat the 1200ms boot-resume
        let maxTabs = 0;
        let ws;
        try {
            ws = new WebSocket('ws://127.0.0.1:7714/ws');
            ws.on('open', () => ws.send(JSON.stringify({ v: 1, t: 'input', d: { kind: 'new-tab' } })));
            ws.on('message', (buf) => {
                try {
                    const f = JSON.parse(buf.toString());
                    const tabs = f && f.d && f.d.tabs;
                    if (Array.isArray(tabs)) maxTabs = Math.max(maxTabs, tabs.length);
                } catch (_) {}
            });
        } catch (e) { check('early-client: ws connected', false, e.message); }
        await sleep(5000);
        const log = srv.log();
        check('early-client: fleet restored alongside its tab', /restore-on-connect: rehydrated 3\/3/.test(log),
            log.split('\n').filter(l => /restore|boot-resume/.test(l)).join(' | '));
        check('early-client: session holds saved + own tabs', maxTabs >= 4, `max snapshot tab count ${maxTabs}`);
        check('early-client: boot-resume knew restore ran', /boot-resume\[1\]: restore-on-connect already ran/.test(log), 'expected the informed-skip line');
        check('early-client: tabs.json never shrank', (readTabs(dir) || 0) >= 3, `file has ${readTabs(dir)}`);
        try { ws && ws.close(); } catch (_) {}
        srv.child.kill('SIGKILL');
    }

    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
})();
