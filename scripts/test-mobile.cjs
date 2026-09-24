// Browser smoke test with isolated sessions and deterministic speech callbacks.
// No real agent is started and no live fleet receives input.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');

(async () => {
    const app = express();
    app.use(express.json());
    const tabs = [{ id: 1, historyId: 'codex-test-1', title: 'Codex test', cols: 40, rows: 12, cwd: '/test' }];
    const inputs = [], sends = [];
    let rejectSend = false;
    app.get('/api/ping', (req, res) => res.json({ ok: true, tokenRequired: false }));
    app.get('/api/capabilities', (req, res) => res.json({ ok: true, capabilities: { manager: false } }));
    app.get('/api/version', (req, res) => res.json({ version: 'test' }));
    app.post('/api/voice/chat/session', (req, res) => {
        if (tabs.length === 1) tabs.push({ id: 2, historyId: 'voice-test-2', title: 'Voice manager', cwd: '/voice', cols: 40, rows: 12 });
        res.json({ ok: true, created: false, tabs, tab: tabs[1] });
    });
    app.post('/api/voice/chat/send', (req, res) => {
        if (rejectSend) return res.status(503).json({ ok: false, error: 'Disconnected — draft kept.' });
        sends.push(req.body);
        res.json({ ok: true });
    });
    app.use('/api', (req, res) => res.json({ ok: true, tabs, capabilities: {}, widgets: {}, sessions: [] }));
    app.use('/m', express.static(path.resolve(__dirname, '../web/public/m')));
    const server = http.createServer(app);
    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', ws => {
        ws.send(JSON.stringify({ t: 'hello', d: { tabs, activeId: 1, replay: [{ id: 1, data: 'Ready\r\n› ' }] } }));
        ws.on('message', raw => {
            const m = JSON.parse(raw);
            if (m.t === 'input') inputs.push(m.d);
            if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', d: {} }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const browser = await chromium.launch({ headless: true,
        ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
    try {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        await context.addInitScript(() => {
            localStorage.setItem('son-of-anton.session', JSON.stringify({ token: 'test', origin: location.origin }));
            window.__speech = [];
            window.SpeechRecognition = class {
                constructor() { window.__rec = this; }
                start() { this.onstart?.(); }
                stop() { this.onend?.(); }
                abort() { this.onend?.(); }
            };
            Object.defineProperty(window, 'speechSynthesis', { value: {
                cancel() {}, getVoices() { return []; }, speak(u) { window.__speech.push(u.text); },
            } });
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => { errors.push(e.message); console.error('Browser error:', e.message); });
        await page.goto(`http://127.0.0.1:${server.address().port}/m/`);
        await page.waitForFunction(() => window._app?._snapshot?.tabs?.length);
        await page.locator('[data-view="chat-view"]').click();
        await page.locator('#chat-manager').click();
        await page.waitForFunction(() => document.getElementById('chat-target').textContent === 'Voice manager');
        await page.locator('#chat-mic').click();
        await page.evaluate(() => {
            window.__rec.onresult({ results: [[{ transcript: 'Check' }]] });
            window.__rec.onresult({ results: [[{ transcript: 'Check deployment status' }]] });
            window.__rec.onend();
        });
        assert.equal(await page.locator('#chat-input').inputValue(), 'Check deployment status');
        assert.equal(sends.length, 0, 'recognition never auto-submits');
        await page.locator('#chat-send').click();
        await page.waitForFunction(() => document.getElementById('chat-input').value === '');
        assert.deepEqual(sends, [{ id: 2, text: 'Check deployment status' }]);
        await page.locator('#chat-read').click();
        for (const ws of wss.clients) ws.send(JSON.stringify({ t: 'tts', d: { tab: 2, text: 'The deployment is healthy.' } }));
        await page.waitForFunction(() => document.getElementById('chat-log').textContent.includes('deployment is healthy'));
        assert.ok((await page.evaluate(() => window.__speech)).includes('The deployment is healthy.'));
        rejectSend = true;
        await page.locator('#chat-input').fill('Keep this draft');
        await page.locator('#chat-send').click();
        await page.waitForFunction(() => document.getElementById('voice-chat-status').textContent.includes('Disconnected'));
        assert.equal(await page.locator('#chat-input').inputValue(), 'Keep this draft');
        await page.locator('#chat-mic').click();
        await page.evaluate(() => window.__rec.onerror({ error: 'not-allowed' }));
        assert.match(await page.locator('#voice-chat-status').textContent(), /denied/);
        assert.equal(await page.locator('#chat-mic').getAttribute('aria-pressed'), 'false');
        await page.screenshot({ path: '/private/tmp/soa-mobile-voice-chat.png' });

        await page.locator('[data-view="terminal-view"]').click();
        const chunks = ['\x1b[?104', '9h\x1b[2J\x1b[H\x1b[?2026hWor', 'king\r\nold reply\x1b[2;', '1H\x1b[2K\x1b[32', 'mCodex stream is readable\x1b[0m\x1b[4;1H› Ready\x1b[?2026l'];
        for (const chunk of chunks) for (const ws of wss.clients)
            ws.send(JSON.stringify({ t: 'term-batch', d: { items: [{ id: 2, data: chunk }] } }));
        await page.waitForFunction(() => document.getElementById('term').textContent.includes('Codex stream is readable'));
        const terminal = await page.locator('#term').textContent();
        assert.ok(!terminal.includes('old reply'));
        await page.screenshot({ path: '/private/tmp/soa-mobile-codex-stream.png' });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(inputs.some(i => i.kind === 'voice-toggle'), false);
        // Real service worker, storage and network loss: reopen the PWA offline.
        await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
        await page.reload();
        await page.waitForFunction(() => window._app?._activeTabId === 2);
        await page.locator('[data-view="chat-view"]').click();
        assert.equal(await page.locator('#chat-input').inputValue(), 'Keep this draft');
        assert.match(await page.locator('#chat-log').textContent(), /Check deployment status/);
        assert.match(await page.locator('#chat-log').textContent(), /deployment is healthy/);
        // A different browser/device sees no local archive or outgoing messages.
        const other = await browser.newContext();
        const otherPage = await other.newPage();
        await otherPage.goto(page.url());
        await otherPage.waitForFunction(() => !!window._app?._snapshot);
        assert.equal(await otherPage.evaluate(() => window._app._history.records.some(r => r.messages.length)), false);
        await other.close();
        await context.setOffline(true);
        for (const ws of wss.clients) ws.terminate();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('#reconnect-history:visible, .welcome-history:visible').click({ timeout: 15000 });
        const history = page.locator('#session-history');
        assert.match(await history.textContent(), /Offline copies/);
        assert.match(await history.textContent(), /Check deployment status/);
        assert.match(await history.textContent(), /Unsent draft: Keep this draft/);
        assert.match(await history.textContent(), /Codex stream is readable/);
        assert.equal(sends.length, 1, 'offline reload never resubmits a message');
        await page.screenshot({ path: '/private/tmp/soa-mobile-offline-history.png' });
        await context.setOffline(false);
        await page.reload();
        await page.waitForFunction(() => window._app?._activeTabId === 2);
        await page.locator('[data-view="chat-view"]').click();
        assert.equal(await page.locator('#chat-input').inputValue(), 'Keep this draft');
        assert.equal(sends.length, 1, 'reconnect never auto-sends a saved draft');
        assert.deepEqual(errors, []);
        console.log('Mobile browser: voice, Codex redraw, layout, device isolation, real offline reload/history/draft, reconnect without duplicate sends passed.');
    } finally {
        await browser.close();
        for (const ws of wss.clients) ws.terminate();
        await new Promise(resolve => wss.close(resolve));
        await new Promise(resolve => server.close(resolve));
    }
})().catch(err => { console.error(err); process.exitCode = 1; });
