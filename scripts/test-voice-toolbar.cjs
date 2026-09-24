// Exercise the production header, styles, sidebar mounting and voice modules.
// Speech callbacks and the backend are isolated; no live terminal gets input.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');

(async () => {
    const root = path.resolve(__dirname, '../web/public');
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const header = index.match(/<header class="topbar">[\s\S]*?<\/header>/)[0];
    const styles = [...index.matchAll(/<link rel="stylesheet" href="\/assets\/[^\"]+">/g)].join('\n');
    const scripts = [...index.matchAll(/<script src="\/assets\/(?:voice-[^\"]+|speech-utils[^\"]+)".*?<\/script>/g)].join('\n');
    const app = express();
    app.use(express.json());
    let audioReads = 0;
    app.get('/api/voice/config', (req, res) => res.json({ config: { wakeWord: 'hey anton', wakeMode: 'wake', interpret: false } }));
    app.get('/api/voice/audio', (req, res) => {
        audioReads++;
        res.json({ devices: [], bluetooth: [], tools: {}, defaults: {} });
    });
    app.use('/api', (req, res) => res.json({ ok: true }));
    app.get('/', (req, res) => res.send(`<!doctype html><html><head>
        <meta name="viewport" content="width=device-width, initial-scale=1">${styles}</head><body>
        <div id="shell" class="shell">${header}<div class="stage no-sidebar no-context">
        <aside id="sidebar" class="sidebar"></aside><main id="test-terminal" tabindex="0">Voice test terminal</main></div></div>
        ${scripts}<script type="module">
        import { mountSidebar, setSidebarHidden } from '/assets/widgets.js?v=54';
        setSidebarHidden(true);
        window.testSidebar = mountSidebar(document.getElementById('sidebar'));
        window.testReady = true;
        </script></body></html>`));
    app.use(express.static(root));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    let browser;
    try {
        browser = await chromium.launch({ headless: true,
            ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        await context.addInitScript(() => {
            const ids = ['clock', 'claude', 'installer', 'globe', 'mobile', 'sysinfo', 'device', 'cpu', 'memory',
                'autopilot', 'manager', 'console', 'network', 'netchart', 'commits', 'contribute', 'perf', 'voice'];
            localStorage.setItem('soa-web:sidebar-layout', JSON.stringify(ids.map(id => ({ id, on: false }))));
            window.recognizers = [];
            window.micStarts = 0;
            window.micAborts = 0;
            window.nextTabs = 0;
            window.__SOA_WEB__ = { _shell: {
                order: [1, 2], activeId: 1, tabs: new Map([[1, { title: 'First' }], [2, { title: 'Second' }]]),
                _activate(id) { this.activeId = id; window.nextTabs++; },
            } };
            window.SpeechRecognition = class {
                constructor() { window.recognizers.push(this); window.testRec = this; }
                start() { window.micStarts++; if (!window.delayMicStart) this.onstart?.(); }
                abort() { window.micAborts++; this.onend?.(); }
                stop() { this.onend?.(); }
            };
            Object.defineProperty(window, 'speechSynthesis', { value: {
                cancel() {}, getVoices() { return []; }, speak() {},
            } });
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.waitForFunction(() => window.testReady);
        const button = page.locator('#toggle-voice');
        const panel = page.locator('#voice-panel');
        const listen = panel.locator('.voice-btn--start');
        const stop = panel.locator('.voice-btn--stop');
        const transcript = text => page.evaluate(text => {
            const result = [{ transcript: text }];
            result.isFinal = true;
            window.testRec.onresult({ resultIndex: 0, results: [result] });
        }, text);
        assert.equal(await page.locator('#topbar-actions').evaluate(el => el.classList.contains('actions-collapsed')), true);
        assert.equal(await button.isVisible(), true, 'Voice stays accessible with toolbar and sidebar collapsed');
        assert.equal(await button.evaluate(el => !!el.closest('.actions-tray')), false);
        assert.equal(await page.evaluate(() => window.micStarts), 0);
        await button.focus();
        await page.keyboard.press('Enter');
        assert.equal(await panel.isVisible(), true);
        assert.equal(await listen.evaluate(el => document.activeElement === el), true);
        assert.equal(await page.evaluate(() => window.micStarts), 0, 'opening controls never activates the mic');
        await listen.click();
        await page.waitForFunction(() => document.querySelector('.voice-status-text').textContent.includes('hey anton'));
        assert.equal(await button.getAttribute('data-state'), 'on');
        const starts = await page.evaluate(() => window.micStarts);
        await page.keyboard.press('Escape');
        assert.equal(await panel.isVisible(), false);
        assert.equal(await button.evaluate(el => document.activeElement === el), true);
        assert.equal(await button.getAttribute('data-state'), 'on', 'closing the panel preserves active listening');
        await button.click();
        assert.equal(await stop.isVisible(), true);
        assert.equal(await page.evaluate(() => window.micStarts), starts, 'reopening reuses the running mic');
        await page.evaluate(() => window.testSidebar.rebuild());
        assert.equal(await button.getAttribute('data-state'), 'on', 'sidebar customization cannot stop voice');
        await transcript('hey anton next tab');
        assert.equal(await page.evaluate(() => window.nextTabs), 1, 'spoken command reaches the terminal control');
        await stop.click();
        await transcript('hey anton next tab');
        assert.equal(await page.evaluate(() => window.nextTabs), 1, 'late results after Stop never act');
        assert.equal(await button.getAttribute('data-state'), 'off');

        await listen.click();
        await page.evaluate(() => window.testRec.onerror({ error: 'not-allowed' }));
        assert.equal(await listen.isVisible(), true);
        assert.equal(await stop.isVisible(), false);
        assert.equal(await button.getAttribute('data-state'), 'off');
        assert.match(await panel.textContent(), /permission denied/);
        await page.evaluate(() => { window.delayMicStart = true; });
        await listen.click();
        assert.equal(await stop.isVisible(), true);
        await stop.click();
        await page.evaluate(() => window.testRec.onstart());
        assert.equal(await button.getAttribute('data-state'), 'off', 'late start cannot revive a stopped mic');
        assert.ok(await page.evaluate(() => window.micAborts) >= 3);

        // Device polling belongs to the visible panel, even with sidebar hidden.
        await Promise.all([
            page.waitForResponse(r => r.url().includes('/api/voice/audio')),
            panel.getByText('Headset & audio', { exact: true }).click(),
        ]);
        assert.ok(audioReads > 0);
        await page.locator('#test-terminal').click();
        assert.equal(await panel.isVisible(), false, 'outside click dismisses controls');
        const reads = audioReads;
        await Promise.all([
            page.waitForResponse(r => r.url().includes('/api/voice/audio')),
            button.click(),
        ]);
        await page.waitForFunction(() => document.querySelector('.voice-audio-body').textContent.includes('Bluetooth'));
        assert.ok(audioReads > reads, 'reopening refreshes devices independently of the sidebar');

        for (const width of [1440, 768, 390]) {
            await page.setViewportSize({ width, height: 844 });
            for (const ui of ['tron', 'minimal', 'liquid']) {
                await page.evaluate(ui => { document.documentElement.dataset.ui = ui; }, ui);
                await page.keyboard.press('Escape');
                await button.click();
                assert.equal(await panel.isVisible(), true, 'Voice remains clickable in each layout');
                const box = await button.boundingBox();
                assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y + box.height <= 44,
                    `top-right voice control fits at ${width}px in ${ui}`);
                const bounds = await panel.boundingBox();
                assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width,
                    `voice panel fits at ${width}px in ${ui}`);
                await page.screenshot({ path: `/private/tmp/soa-voice-toolbar-${width}-${ui}.png` });
            }
        }
        await page.keyboard.press('Escape');
        assert.equal(await button.getAttribute('aria-expanded'), 'false');
        await page.evaluate(() => window.testSidebar.destroy());
        assert.equal(await panel.count(), 0);
        assert.deepEqual(errors, []);

        // Unsupported browsers retain an actionable entry point.
        await context.addInitScript(() => { window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; });
        await page.reload();
        await page.waitForFunction(() => window.testReady);
        await button.click();
        assert.match(await panel.textContent(), /keyboard dictation/);
        assert.equal(await panel.locator('.voice-btn--start').count(), 0);
        assert.deepEqual(errors, []);
        console.log('Voice toolbar passed: collapsed controls, keyboard access, one mic session, commands, Stop races, permission recovery, device refresh, 3 widths × 3 themes, unsupported browser.');
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
})().catch(err => { console.error(err); process.exitCode = 1; });
