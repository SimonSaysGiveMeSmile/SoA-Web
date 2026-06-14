/**
 * Agent Browser — per-tab isolated headless Chromium instances that agents
 * (Claude Code in a terminal) can drive, with each instance's live view
 * streamed into the SoA BROWSER / MONITOR panels via CDP screencast.
 *
 * Each TAB gets its OWN Chromium process with its OWN --user-data-dir, so:
 *   - agents never fight over a single shared page (the old problem),
 *   - cookies/logins are isolated per agent AND persist across restarts
 *     (the per-tab profile dir survives a daemon restart), and
 *   - a runaway page only crashes that agent's browser, not the whole fleet.
 *
 * Instances are LAZY (spawned on the first `soa-browser` call for a tab),
 * CAPPED (MAX_INSTANCES, least-recently-used reaped when no one's watching),
 * and REAPED when their tab exits. An instance's screencast runs only while it
 * has at least one subscriber.
 *
 * Keyed by tab id, which agents carry via $SOA_WEB_TAB (injected per shell —
 * see tabManager). Calls with no tab id fall back to a shared 'default'
 * instance (back-compat for the manager agent / ad-hoc shells / older clients).
 *
 * CDP is spoken directly over the DevTools WebSocket using `ws` — no puppeteer.
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const express = require('express');
const { MSG, frame } = require('./protocol');

// Base remote-debug port; each instance claims the next free one above it.
// Overridable so two daemons on one machine (prod + the s0a.app product
// install) don't fight over the same range.
const BASE_PORT = Number(process.env.SOA_WEB_BROWSER_DEBUG_PORT) || 9223;
const MAX_INSTANCES = Number(process.env.SOA_WEB_BROWSER_MAX) || 6;
const PROFILE_ROOT = require('./stateDir').stateFile('agent-chrome');
const VIEW = { w: 1024, h: 768 };

let _sessions = null;                 // SessionStore (unused directly; sinks carry .send)
const _instances = new Map();         // key -> Instance
const _usedPorts = new Set();

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

function _httpGet(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let body = ''; res.on('data', d => body += d); res.on('end', () => resolve(body));
        });
        req.on('error', reject);
        req.setTimeout(2000, () => req.destroy(new Error('timeout')));
    });
}

function _pickPort() {
    for (let p = BASE_PORT; p < BASE_PORT + 200; p++) {
        if (!_usedPorts.has(p)) { _usedPorts.add(p); return p; }
    }
    throw new Error('no free debug port');
}

// Persist each tab's profile under a sanitized, stable dir so logins survive a
// daemon restart for that same tab id.
function _profileDir(key) {
    const safe = String(key).replace(/[^A-Za-z0-9_-]/g, '_') || 'default';
    return path.join(PROFILE_ROOT, safe);
}

function _key(tabId) {
    return (tabId == null || tabId === '') ? 'default' : String(tabId);
}

class Instance {
    constructor(key) {
        this.key = key;
        this.port = 0;
        this.proc = null;
        this.cdp = null;
        this.ready = false;
        this.msgId = 0;
        this.pending = new Map();
        this.screencasting = false;
        this.subscribers = new Set();   // session-like sinks with .send(payload)
        this.lastUrl = 'about:blank';
        this.lastUsed = Date.now();
    }

    async _waitForTargetWs() {
        for (let i = 0; i < 50; i++) {
            try {
                const list = JSON.parse(await _httpGet(`http://127.0.0.1:${this.port}/json`));
                const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
                if (page) return page.webSocketDebuggerUrl;
            } catch (_) {}
            await new Promise(r => setTimeout(r, 200));
        }
        throw new Error('chromium devtools not reachable');
    }

    _send(method, params = {}) {
        return new Promise((resolve, reject) => {
            if (!this.cdp || this.cdp.readyState !== 1) return reject(new Error('cdp not connected'));
            const id = ++this.msgId;
            this.pending.set(id, { resolve, reject });
            this.cdp.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); }
            }, 15000);
        });
    }

    _onCdpMessage(raw) {
        let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
        if (msg.id && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message || 'cdp error'));
            else resolve(msg.result);
            return;
        }
        if (msg.method === 'Page.screencastFrame') {
            const { data, sessionId } = msg.params;
            this._send('Page.screencastFrameAck', { sessionId }).catch(() => {});
            // Stamp frames with this tab's key so the panel/monitor routes each
            // stream to the right cell; deliver only to this instance's watchers.
            const payload = frame(MSG.BROWSER_FRAME, { tabId: this.key, data });
            for (const sink of this.subscribers) { try { sink.send(payload); } catch (_) {} }
        }
    }

    async ensure() {
        this.lastUsed = Date.now();
        if (this.ready && this.cdp && this.cdp.readyState === 1) return;
        const bin = findChrome();
        if (!bin) throw new Error('no Chromium/Chrome found');
        if (!this.proc) {
            if (!this.port) this.port = _pickPort();
            const profile = _profileDir(this.key);
            fs.mkdirSync(profile, { recursive: true });
            this.proc = spawn(bin, [
                '--headless=new',
                `--remote-debugging-port=${this.port}`,
                `--user-data-dir=${profile}`,
                `--window-size=${VIEW.w},${VIEW.h}`,
                '--no-first-run', '--no-default-browser-check',
                '--disable-gpu', '--hide-scrollbars', '--mute-audio',
                'about:blank',
            ], { stdio: 'ignore', detached: false });
            this.proc.on('exit', () => { this.proc = null; this.cdp = null; this.ready = false; this.screencasting = false; });
        }
        const wsUrl = await this._waitForTargetWs();
        await new Promise((resolve, reject) => {
            this.cdp = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
            this.cdp.on('open', resolve);
            this.cdp.on('error', reject);
            this.cdp.on('message', (m) => this._onCdpMessage(m));
            this.cdp.on('close', () => { this.cdp = null; this.ready = false; this.screencasting = false; });
        });
        await this._send('Page.enable');
        await this._send('Runtime.enable');
        await this._send('Page.setDeviceMetricsOverride', { width: VIEW.w, height: VIEW.h, deviceScaleFactor: 1, mobile: false });
        this.ready = true;
        if (this.subscribers.size > 0) await this._startScreencast();
    }

    async _startScreencast() {
        if (this.screencasting) return;
        await this.ensure();
        await this._send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: VIEW.w, maxHeight: VIEW.h, everyNthFrame: 1 });
        this.screencasting = true;
    }
    async _stopScreencast() {
        if (!this.screencasting) return;
        try { await this._send('Page.stopScreencast'); } catch (_) {}
        this.screencasting = false;
    }

    async command(action, args = {}) {
        await this.ensure();
        this.lastUsed = Date.now();
        switch (action) {
            case 'navigate': {
                let url = String(args.url || '').trim();
                if (url && !/^[a-z]+:\/\//i.test(url)) url = 'http://' + url;
                await this._send('Page.navigate', { url });
                await new Promise(r => setTimeout(r, 800));
                this.lastUrl = url;
                return { ok: true, url };
            }
            case 'click': {
                const x = Number(args.x), y = Number(args.y);
                await this._send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
                await this._send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
                return { ok: true };
            }
            case 'type': {
                await this._send('Input.insertText', { text: String(args.text || '') });
                return { ok: true };
            }
            case 'key': {
                const key = String(args.key || '');
                const map = { Enter: '\r', Tab: '\t', Backspace: '\b' };
                await this._send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: map[key] || undefined });
                await this._send('Input.dispatchKeyEvent', { type: 'keyUp', key });
                return { ok: true };
            }
            case 'scroll': {
                const dy = Number(args.dy || 300);
                await this._send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: VIEW.w / 2, y: VIEW.h / 2, deltaX: 0, deltaY: dy });
                return { ok: true };
            }
            case 'back': { await this._send('Runtime.evaluate', { expression: 'history.back()' }); return { ok: true }; }
            case 'eval': {
                const r = await this._send('Runtime.evaluate', { expression: String(args.js || ''), returnByValue: true, awaitPromise: true });
                return { ok: true, value: r.result && r.result.value };
            }
            case 'screenshot': {
                const r = await this._send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
                return { ok: true, data: r.data }; // base64 jpeg
            }
            case 'url': {
                const r = await this._send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
                this.lastUrl = (r.result && r.result.value) || this.lastUrl;
                return { ok: true, url: this.lastUrl };
            }
            default: throw new Error('unknown action: ' + action);
        }
    }

    async teardown() {
        try { await this._stopScreencast(); } catch (_) {}
        try { if (this.cdp) this.cdp.close(); } catch (_) {}
        try { if (this.proc) this.proc.kill('SIGTERM'); } catch (_) {}
        if (this.port) _usedPorts.delete(this.port);
        this.subscribers.clear();
        this.ready = false;
    }
}

// Evict the least-recently-used instance that nobody is watching, to stay under
// the cap. An instance with subscribers is never reaped out from under a viewer.
function _reapIfNeeded() {
    if (_instances.size < MAX_INSTANCES) return;
    let victim = null;
    for (const inst of _instances.values()) {
        if (inst.subscribers.size > 0) continue;
        if (!victim || inst.lastUsed < victim.lastUsed) victim = inst;
    }
    if (victim) { victim.teardown().catch(() => {}); _instances.delete(victim.key); }
}

function _getOrCreate(tabId) {
    const k = _key(tabId);
    let inst = _instances.get(k);
    if (!inst) {
        _reapIfNeeded();
        inst = new Instance(k);
        _instances.set(k, inst);
    }
    return inst;
}

// ── Public API (all take an optional tabId; null → shared 'default') ────────
async function command(tabId, action, args = {}) {
    return _getOrCreate(tabId).command(action, args);
}

async function subscribe(tabId, sink) {
    const inst = _getOrCreate(tabId);
    if (sink) inst.subscribers.add(sink);
    if (inst.subscribers.size >= 1) await inst._startScreencast().catch(() => {});
}

async function unsubscribe(tabId, sink) {
    const inst = _instances.get(_key(tabId));
    if (!inst) return;
    if (sink) inst.subscribers.delete(sink);
    if (inst.subscribers.size === 0) await inst._stopScreencast().catch(() => {});
}

// Drop a sink from every instance (e.g. a socket/session disconnecting).
function unsubscribeAll(sink) {
    for (const inst of _instances.values()) {
        if (inst.subscribers.delete(sink) && inst.subscribers.size === 0) {
            inst._stopScreencast().catch(() => {});
        }
    }
}

function teardown(tabId) {
    const k = _key(tabId);
    const inst = _instances.get(k);
    if (!inst) return;
    inst.teardown().catch(() => {});
    _instances.delete(k);
}

function listInstances() {
    return [...(_instances.values())].map(i => ({
        tabId: i.key,
        url: i.lastUrl,
        running: !!i.proc,
        watching: i.subscribers.size,
    }));
}

function ensure(tabId) { return _getOrCreate(tabId).ensure(); }

function mount(app, requireAuthed, sessions) {
    _sessions = sessions;
    // Agents reach this from localhost; the SoA panel reaches it authed.
    app.post('/api/agent-browser', express.json({ limit: '256kb' }), async (req, res) => {
        const body = req.body || {};
        const action = String(body.action || '');
        if (action === 'list') { res.json({ ok: true, instances: listInstances() }); return; }
        try {
            const result = await command(body.tab, action, body);
            res.json(result);
        } catch (err) {
            res.status(500).json({ ok: false, error: err && err.message || 'failed' });
        }
    });
}

module.exports = { mount, command, subscribe, unsubscribe, unsubscribeAll, teardown, listInstances, ensure };
