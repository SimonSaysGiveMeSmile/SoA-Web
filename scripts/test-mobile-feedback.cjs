const assert = require('node:assert/strict');

module.exports = async function testFeedback(browser, url) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.addInitScript(() => {
        window.__spokenReplies = [];
        Object.defineProperty(window, 'speechSynthesis', { value: { cancel() {}, getVoices() { return []; }, speak(u) { window.__spokenReplies.push(u.text); } } });
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const replies = [];
    await page.route('**/api/voice/chat/replies?*', route => route.fulfill({ json: { ok: true, replies } }));
    try {
        await page.goto(url);
        await page.waitForFunction(() => window._app?._snapshot?.tabs?.length);
        await page.locator('[data-view="chat-view"]').click();
        const id = await page.evaluate(() => window._app._activeTabId);
        await page.evaluate(id => window._app._applyTerminalChunk({ id, data: '\x1b[2J\x1b[HAre you on your phone or Mac?\r\nPhone / This Mac\r\n? 1 question' }), id);
        await page.waitForFunction(() => document.querySelector('#chat-feedback').open);
        assert.match(await page.locator('#chat-feedback').textContent(), /Are you on your phone or Mac/);
        replies.push({ id: 'reply-test:1', tab: id, text: 'Your reply survived the reconnect.', at: Date.now() });
        await page.evaluate(() => window._app._pollReplies());
        await page.waitForFunction(() => document.getElementById('chat-log').textContent.includes('survived the reconnect'));
        await page.evaluate(() => window._app._pollReplies());
        assert.equal(await page.locator('#chat-log .agent').count(), 1, 'repeated polling cannot duplicate replies');
        await page.getByRole('button', { name: 'Play latest reply' }).click();
        assert.deepEqual(await page.evaluate(() => window.__spokenReplies), ['Your reply survived the reconnect.']);
        await page.getByRole('button', { name: 'Open terminal to respond' }).click();
        assert.equal(await page.locator('#terminal-view').evaluate(el => el.classList.contains('active')), true);

        // A busy fleet must not rebuild the hidden terminal DOM while Chat is open.
        await page.locator('[data-view="chat-view"]').click();
        await page.evaluate(() => {
            const a = window._app;
            a._applySnapshot({ tabs: Array.from({ length: 26 }, (_, n) => ({ id: n + 1, title: 'Stress ' + n, historyId: 'stress-' + n, rows: 24, cols: 100 })), activeId: 1 });
            window.__terminalMutations = 0;
            window.__observer = new MutationObserver(records => { window.__terminalMutations += records.length; });
            window.__observer.observe(document.getElementById('term'), { childList: true, subtree: true });
            for (let id = 1; id <= 26; id++) a._applyTerminalChunk({ id, data: ('stream ' + 'x'.repeat(80) + '\r\n').repeat(1000) + 'LATEST-' + id });
        });
        await page.waitForFunction(() => Array.from(window._app._tabStates, ([id, ts]) => ts.term.recentText(2).includes('LATEST-' + id)).every(Boolean));
        assert.equal(await page.evaluate(() => window.__terminalMutations), 0, 'hidden stream causes no terminal DOM rebuild');
        assert.equal(await page.evaluate(() => [...window._app._tabStates.values()].every(ts => ts.term.lineCount() <= 624)), true);
        await page.locator('[data-view="terminal-view"]').click();
        await page.waitForFunction(() => document.getElementById('term').textContent.includes('LATEST-'));
        assert.ok(await page.locator('#term').evaluate(el => el.textContent.split('\n').length) <= 400);
        const disposed = await page.evaluate(() => {
            const previous = [...window._app._tabStates.values()];
            window._app._softReload();
            return previous.every(ts => ts.term._disposed);
        });
        assert.equal(disposed, true, 'soft reconnect disposes all 26 old parsers');
        await page.waitForFunction(() => window._app?._snapshot?.tabs?.length === 2);
        assert.deepEqual(errors, []);
        console.log('Mobile feedback: waiting question, recovered reply, deduplication, tap-to-play, 26-tab streaming, hidden DOM, bounded scrollback and reconnect disposal passed.');
    } finally { await context.close(); }
};
