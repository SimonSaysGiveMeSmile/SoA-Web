#!/usr/bin/env node
/**
 * Tap-free App Store screenshot generator for the SoA mobile client.
 *
 * Produces native iPhone 16 Pro Max shots (6.9" / 1320×2868 — the App Store
 * requirement) with ZERO simulator taps:
 *   1. launch a private headless Chrome,
 *   2. emulate the device metrics (440×956 logical @ dsf 3 = 1320×2868 physical),
 *   3. deep-link each screen via the client's own `?view=` router
 *      (see web/public/m/app.js — INITIAL_VIEW / VIEW_ALIASES),
 *   4. let the WS-fed UI settle, then captureScreenshot clipped to exactly
 *      1320×2868.
 *
 * The rendering engine is Blink rather than the app's WKWebView, but the bundled
 * client is plain HTML/CSS (flat panels, monospace terminal) so the result is
 * visually identical at screenshot scale. For final polish you can re-shoot the
 * same URLs on the sim once a demo backend has live content:
 *   xcrun simctl openurl <udid> "<backend>/m/?view=chat&t=<token>"
 *   xcrun simctl io  <udid> screenshot out.png
 *
 * Usage:
 *   node capture-screenshots.js                     # against http://localhost:4010
 *   SOA_BACKEND=https://demo.example.com node capture-screenshots.js
 *
 * Requires Node 18+ (global WebSocket) and Google Chrome.
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME_BIN
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT) || 9333;
const BACKEND = (process.env.SOA_BACKEND || 'http://localhost:4010').replace(/\/+$/, '');
const OUT = process.env.OUT_DIR || path.join(__dirname, 'screenshots');
const PROFILE = path.join(os.tmpdir(), 'soa-shots-profile');

// iPhone 16 Pro Max: 440×956 CSS px @3× = 1320×2868 physical (App Store 6.9").
const DEV = { width: 440, height: 956, deviceScaleFactor: 3, mobile: true,
              screenWidth: 440, screenHeight: 956 };

// Which screens to shoot. Terminal (01) is captured on a real device/sim for
// the hero; the rest render cleanly headless. `settle` = ms to wait for the
// WS-fed view to populate before the shot.
const VIEWS = [
    { view: 'dash',    file: '02-fleet-manager.png', settle: 4500 },
    { view: 'system',  file: '03-system.png',        settle: 3500 },
    { view: 'chat',    file: '04-chat.png',          settle: 3500 },
    { view: 'browser', file: '05-browser.png',       settle: 4000 },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const httpGet = (url) => new Promise((resolve, reject) => {
    http.get(url, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); })
        .on('error', reject);
});

let msgId = 0;
function send(ws, method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
        const onMsg = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch { return; }
            if (m.id !== id) return;
            ws.removeEventListener('message', onMsg);
            m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result);
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method, params }));
    });
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}

    const chrome = spawn(CHROME, [
        '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
        '--no-first-run', '--no-default-browser-check',
        `--window-size=${DEV.width},${DEV.height}`, 'about:blank',
    ], { stdio: 'ignore' });

    let wsUrl = null;
    for (let i = 0; i < 40 && !wsUrl; i++) {
        try {
            const list = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json`));
            const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
            if (page) wsUrl = page.webSocketDebuggerUrl;
        } catch {}
        if (!wsUrl) await sleep(250);
    }
    if (!wsUrl) { console.error('no devtools page target'); chrome.kill(); process.exit(1); }

    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', rej, { once: true });
    });

    await send(ws, 'Page.enable');
    await send(ws, 'Runtime.enable');
    await send(ws, 'Emulation.setDeviceMetricsOverride', DEV);
    await send(ws, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

    console.log(`backend: ${BACKEND}  →  ${OUT}`);
    for (const v of VIEWS) {
        await send(ws, 'Page.navigate', { url: `${BACKEND}/m/?view=${v.view}` });
        await sleep(v.settle);
        try {
            const probe = await send(ws, 'Runtime.evaluate', {
                expression: `JSON.stringify({visible:[...document.querySelectorAll('[id$="-view"]')]`
                    + `.filter(e=>e.offsetParent!==null).map(e=>e.id),len:document.body.innerText.length})`,
                returnByValue: true,
            });
            console.log(`  [${v.view}] ${probe.result.value}`);
        } catch (e) { console.log(`  [${v.view}] probe failed: ${e.message}`); }

        const shot = await send(ws, 'Page.captureScreenshot', {
            format: 'png', captureBeyondViewport: false,
            clip: { x: 0, y: 0, width: DEV.width, height: DEV.height, scale: 1 },
        });
        fs.writeFileSync(path.join(OUT, v.file), Buffer.from(shot.data, 'base64'));
        console.log(`  saved ${v.file}`);
    }

    ws.close();
    chrome.kill();
    await sleep(300);
    console.log('done — verify each PNG is 1320×2868');
    process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
