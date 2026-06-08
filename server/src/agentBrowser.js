/**
 * Agent Browser — an isolated, server-managed headless Chromium that agents
 * (Claude Code in a terminal) can drive for testing/automation, with its live
 * view streamed into the SoA BROWSER panel via CDP screencast.
 *
 * Isolation: a dedicated headless Chromium with its own --user-data-dir, fully
 * separate from the user's real Chrome and from the SoA UI — automation can't
 * touch the user's windows, tabs, or logins.
 *
 * Control surface:
 *   - Agents: `soa-browser <cmd>` → POST /api/agent-browser  (navigate, click,
 *     type, key, eval, screenshot, scroll, back).
 *   - The SoA panel: subscribes to a JPEG screencast (MSG 'browser-frame') and
 *     forwards taps back as clicks, so the human can watch and also interact.
 *
 * CDP is spoken directly over the DevTools WebSocket using `ws` — no puppeteer.
 */

const { spawn, execFile } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const WebSocket = require('ws');
const express = require('express');
const { MSG, frame } = require('./protocol');

const DEBUG_PORT = 9223;
const PROFILE = path.join(os.homedir(), '.soa-web', 'agent-chrome');
const VIEW = { w: 1024, h: 768 };

function findChrome() {
    // Prefer real Chrome app bundles; the homebrew `chromium` symlink is often a
    // dead wrapper. Resolve symlinks and require an executable regular file.
    const candidates = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        '/opt/homebrew/bin/chromium',
        '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    ];
    for (const c of candidates) {
        try {
            const real = fs.realpathSync(c);
            const st = fs.statSync(real);
            if (st.isFile()) { fs.accessSync(real, fs.constants.X_OK); return real; }
        } catch (_) {}
    }
    return null;
}

let _sessions = null;     // SessionStore, for broadcasting frames
let _proc = null;         // chromium process
let _cdp = null;          // CDP websocket
let _ready = false;
let _msgId = 0;
const _pending = new Map();
let _screencasting = false;
let _subscribers = 0;     // panel viewers; screencast runs while > 0

function _httpGet(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let body = ''; res.on('data', d => body += d); res.on('end', () => resolve(body));
        });
        req.on('error', reject);
        req.setTimeout(2000, () => req.destroy(new Error('timeout')));
    });
}

async function _waitForTargetWs() {
    // Poll the DevTools /json endpoint until a page target appears.
    for (let i = 0; i < 50; i++) {
        try {
            const list = JSON.parse(await _httpGet(`http://127.0.0.1:${DEBUG_PORT}/json`));
            const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
            if (page) return page.webSocketDebuggerUrl;
        } catch (_) {}
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('chromium devtools not reachable');
}

function _send(method, params = {}) {
    return new Promise((resolve, reject) => {
        if (!_cdp || _cdp.readyState !== 1) return reject(new Error('cdp not connected'));
        const id = ++_msgId;
        _pending.set(id, { resolve, reject });
        _cdp.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
            if (_pending.has(id)) { _pending.delete(id); reject(new Error('cdp timeout: ' + method)); }
        }, 15000);
    });
}

function _onCdpMessage(raw) {
    let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
    if (msg.id && _pending.has(msg.id)) {
        const { resolve, reject } = _pending.get(msg.id);
        _pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'cdp error'));
        else resolve(msg.result);
        return;
    }
    if (msg.method === 'Page.screencastFrame') {
        const { data, sessionId } = msg.params;
        _send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        if (_sessions) {
            const payload = frame(MSG.BROWSER_FRAME, { data });
            for (const s of _sessions.sessions.values()) s.send(payload);
        }
    }
}

async function ensure() {
    if (_ready && _cdp && _cdp.readyState === 1) return;
    const bin = findChrome();
    if (!bin) throw new Error('no Chromium/Chrome found');
    if (!_proc) {
        fs.mkdirSync(PROFILE, { recursive: true });
        _proc = spawn(bin, [
            '--headless=new',
            `--remote-debugging-port=${DEBUG_PORT}`,
            `--user-data-dir=${PROFILE}`,
            `--window-size=${VIEW.w},${VIEW.h}`,
            '--no-first-run', '--no-default-browser-check',
            '--disable-gpu', '--hide-scrollbars', '--mute-audio',
            'about:blank',
        ], { stdio: 'ignore', detached: false });
        _proc.on('exit', () => { _proc = null; _cdp = null; _ready = false; _screencasting = false; });
    }
    const wsUrl = await _waitForTargetWs();
    await new Promise((resolve, reject) => {
        _cdp = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
        _cdp.on('open', resolve);
        _cdp.on('error', reject);
        _cdp.on('message', _onCdpMessage);
        _cdp.on('close', () => { _cdp = null; _ready = false; _screencasting = false; });
    });
    await _send('Page.enable');
    await _send('Runtime.enable');
    await _send('Page.setDeviceMetricsOverride', { width: VIEW.w, height: VIEW.h, deviceScaleFactor: 1, mobile: false });
    _ready = true;
    if (_subscribers > 0) await _startScreencast();
}

async function _startScreencast() {
    if (_screencasting) return;
    await ensure();
    await _send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: VIEW.w, maxHeight: VIEW.h, everyNthFrame: 1 });
    _screencasting = true;
}
async function _stopScreencast() {
    if (!_screencasting) return;
    try { await _send('Page.stopScreencast'); } catch (_) {}
    _screencasting = false;
}

// Called by the WS layer when a panel subscribes/unsubscribes to the live view.
async function subscribe() { _subscribers++; if (_subscribers === 1) await _startScreencast().catch(() => {}); }
async function unsubscribe() { _subscribers = Math.max(0, _subscribers - 1); if (_subscribers === 0) await _stopScreencast().catch(() => {}); }

// ── Commands ─────────────────────────────────────────────────────────────
async function command(action, args = {}) {
    await ensure();
    switch (action) {
        case 'navigate': {
            let url = String(args.url || '').trim();
            if (url && !/^[a-z]+:\/\//i.test(url)) url = 'http://' + url;
            await _send('Page.navigate', { url });
            await new Promise(r => setTimeout(r, 800));
            return { ok: true, url };
        }
        case 'click': {
            const x = Number(args.x), y = Number(args.y);
            await _send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
            await _send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
            return { ok: true };
        }
        case 'type': {
            await _send('Input.insertText', { text: String(args.text || '') });
            return { ok: true };
        }
        case 'key': {
            const key = String(args.key || '');
            const map = { Enter: '\r', Tab: '\t', Backspace: '\b' };
            await _send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: map[key] || undefined });
            await _send('Input.dispatchKeyEvent', { type: 'keyUp', key });
            return { ok: true };
        }
        case 'scroll': {
            const dy = Number(args.dy || 300);
            await _send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: VIEW.w / 2, y: VIEW.h / 2, deltaX: 0, deltaY: dy });
            return { ok: true };
        }
        case 'back': { await _send('Runtime.evaluate', { expression: 'history.back()' }); return { ok: true }; }
        case 'eval': {
            const r = await _send('Runtime.evaluate', { expression: String(args.js || ''), returnByValue: true, awaitPromise: true });
            return { ok: true, value: r.result && r.result.value };
        }
        case 'screenshot': {
            const r = await _send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
            return { ok: true, data: r.data }; // base64 jpeg
        }
        case 'url': {
            const r = await _send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
            return { ok: true, url: r.result && r.result.value };
        }
        default: throw new Error('unknown action: ' + action);
    }
}

function mount(app, requireAuthed, sessions) {
    _sessions = sessions;
    // Agents reach this from localhost; the SoA panel reaches it authed.
    app.post('/api/agent-browser', express.json({ limit: '256kb' }), async (req, res) => {
        const body = req.body || {};
        try {
            const result = await command(String(body.action || ''), body);
            res.json(result);
        } catch (err) {
            res.status(500).json({ ok: false, error: err && err.message || 'failed' });
        }
    });
}

module.exports = { mount, command, subscribe, unsubscribe, ensure };
