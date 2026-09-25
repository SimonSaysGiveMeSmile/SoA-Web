// Test the real usage widget in Chromium without reading personal usage data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');

(async () => {
    const root = path.resolve(__dirname, '../web/public');
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const styles = [...index.matchAll(/<link rel="stylesheet" href="\/assets\/[^\"]+">/g)].join('\n');
    const app = express();
    app.get('/usage-test.js', (req, res) => res.type('js').send(
        fs.readFileSync(path.join(root, 'assets/widgets.js'), 'utf8') + '\nexport { ClaudeUsageWidget };'));
    app.get('/', (req, res) => res.send(`<!doctype html><html><head>${styles}</head><body>
        <div id="fixture" style="width:300px;padding:8px"></div><button id="after">After widget</button>
        <script type="module">
        import { ClaudeUsageWidget } from '/usage-test.js';
        window.__SOA_WEB__ = { _shell: { _managerEnabled: () => window.entitled !== false } };
        window.widget = new ClaudeUsageWidget({ parent: document.getElementById('fixture') });
        </script></body></html>`));
    app.use(express.static(root));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const now = Date.now();
    const claude = { block: { active: true, pct: 95, elapsedMs: 17100000, startTs: now - 17100000,
        endTs: now + 900000, remainingMs: 900000, tokens: { total: 500 }, requests: 2,
        cost: 1, burnRatePerMin: 50, lastTs: now }, week: { cost: 366, tokens: { total: 1000 } },
        today: { tokens: { total: 700 }, cost: 2 }, models: [{ tier: 'test', tokens: 700 }], sessions: [], series: [1, 2, 3] };
    const codex = { available: true, limits: { primary: { label: '5H', usedPercent: 30,
        windowMinutes: 300, remainingMs: 600000, resetsAt: now + 600000 },
        secondary: { label: 'WEEKLY', usedPercent: 60 } }, today: { tokens: { total: 800, output: 100 } },
        models: [], sessions: [], series: [3, 2, 1], burnRatePerMin: 50, lastTs: now };
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    let browser;
    try {
        browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
        let state, counts, delay = 0;
        const errors = [];
        const context = await browser.newContext({ viewport: { width: 800, height: 1100 } });
        await context.addInitScript(now => { window.testNow = now; Date.now = () => window.testNow; }, now);
        await context.route('**/api/*', async route => {
            const key = route.request().url().includes('codex-usage') ? 'codex' : 'claude';
            counts[key]++;
            if (delay) await new Promise(resolve => setTimeout(resolve, delay));
            const value = state[key];
            await route.fulfill({ status: typeof value === 'number' ? value : 200,
                contentType: 'application/json', body: JSON.stringify({ data: typeof value === 'number' ? null : value }) });
        });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        const reset = async (saved = null) => {
            counts = { claude: 0, codex: 0 };
            state = { claude: structuredClone(claude), codex: structuredClone(codex) };
            await page.goto(`http://127.0.0.1:${server.address().port}/`);
            await page.evaluate(saved => {
                if (saved) localStorage.setItem('soa_usage_open', saved);
                else localStorage.removeItem('soa_usage_open');
            }, saved);
            await page.reload();
            await page.waitForFunction(() => !!window.widget);
        };
        const tick = () => page.evaluate(() => window.widget.tick());
        await reset();
        assert.equal(await page.locator('[data-src="codex"].usage-card').isVisible(), false);
        await tick();
        const cards = page.locator('.usage-card');
        assert.equal(await cards.count(), 2);
        assert.equal(await cards.nth(0).locator('.usage-card-big').textContent(), '≈10%');
        assert.equal(await cards.nth(0).locator('.ring-a').evaluate(el => el.classList.contains('none')), true);
        assert.equal(await cards.nth(0).locator('.ring-c').evaluate(el => el.classList.contains('hot') || el.classList.contains('crit')), false);
        assert.match(await cards.nth(0).getAttribute('aria-label'), /weekly usage approximately 10 percent/);
        assert.match(await cards.nth(1).getAttribute('aria-label'), /WEEKLY usage 60 percent/);
        await cards.nth(1).focus();
        await page.keyboard.press('Tab');
        assert.equal(await page.locator('#after').evaluate(el => el === document.activeElement), true,
            'collapsed dashboard button must not receive keyboard focus');
        await cards.nth(0).click();
        await page.waitForFunction(() => !window.widget._fetching);
        assert.equal(await page.locator('.usage-detail').getAttribute('aria-hidden'), 'false');
        assert.match(await page.locator('.usage-leg-a').textContent(), /limit not reported/);
        await page.locator('.usage-more').focus();
        await page.evaluate(() => window.widget._toggle('claude'));
        assert.equal(await cards.nth(0).evaluate(el => el === document.activeElement), true);
        await page.keyboard.press('Enter');
        await cards.nth(0).dispatchEvent('keydown', { key: 'Enter', repeat: true });
        assert.equal(await cards.nth(0).getAttribute('aria-expanded'), 'true', 'held key must not repeatedly toggle');

        for (const theme of ['tron', 'minimal', 'liquid']) {
            await page.evaluate(theme => { document.documentElement.dataset.ui = theme; }, theme);
            for (const width of [240, 300, 380]) {
                await page.locator('#fixture').evaluate((el, width) => { el.style.width = width + 'px'; }, width);
                for (const source of ['claude', 'codex']) {
                    await page.evaluate(source => {
                        if (window.widget._open !== source) window.widget._toggle(source);
                    }, source);
                    await page.waitForFunction(() => !window.widget._fetching);
                    assert.equal(await page.locator('#fixture').evaluate(el => el.scrollWidth <= el.clientWidth), true,
                        `${theme} at ${width}px must not overflow`);
                }
            }
            await page.screenshot({ path: `/private/tmp/soa-usage-rings-${theme}.png` });
        }
        await reset('codex');
        state = { claude: 404, codex: 404 };
        await tick();
        for (let i = 0; i < 6; i++) { await page.evaluate(() => { window.testNow += 2500; }); await tick(); }
        assert.equal(counts.codex, 1, 'a remembered Codex panel must not bypass failed-request backoff');
        await page.evaluate(() => { window.testNow += 5000; });
        await tick();
        assert.equal(counts.codex, 2, 'retry after twenty seconds');
        assert.match(await cards.nth(0).textContent(), /Unavailable/);

        await reset('codex');
        state.claude = 500;
        await tick();
        assert.equal(await cards.nth(1).isVisible(), true, 'Codex can load even if Claude fails');
        assert.equal(await page.locator('.usage-detail').getAttribute('aria-hidden'), 'false');
        state.codex = 500;
        await tick();
        assert.match(await page.locator('.usage-status').textContent(), /last update/);
        assert.equal(await cards.nth(1).evaluate(el => el.classList.contains('live')), false);
        const failedCount = counts.codex;
        await tick();
        assert.equal(counts.codex, failedCount, 'a failed visible source also backs off');
        state = { claude: structuredClone(claude), codex: structuredClone(codex) };
        await page.evaluate(() => { window.testNow += 20000; });
        await tick();
        assert.equal(await page.locator('.usage-status').textContent(), '');
        state.codex.limits.primary.resetsAt = null;
        await tick();
        assert.equal(await cards.nth(1).locator('.ring-c').evaluate(el => el.classList.contains('none')), true);
        assert.equal(await page.locator('.usage-leg-c .usage-leg-v').textContent(), '—');
        await page.evaluate(() => { window.entitled = false; window.widget._paintOpen(); });
        assert.equal(await page.locator('.usage-more').isVisible(), false);

        await reset();
        delay = 80;
        await page.evaluate(() => Promise.all([window.widget.tick(), window.widget.tick(), window.widget.tick()]));
        assert.deepEqual(counts, { claude: 1, codex: 1 }, 'concurrent refreshes share one request per source');
        delay = 0;
        state.claude.week.cost = 4392;
        state.claude.models = [{ tier: 'other', tokens: 0 }];
        await page.evaluate(() => window.widget._toggle('claude'));
        await page.waitForFunction(() => !window.widget._fetching);
        assert.equal(await cards.nth(0).locator('.usage-card-big').textContent(), '≈120%');
        assert.equal(await page.locator('.usage-leg-b .usage-leg-v').textContent(), '≈120% of ≈$3660');
        assert.equal(await page.evaluate(() => window.widget._model.v.textContent), '—');
        assert.deepEqual(errors, []);
        console.log('Usage widget passed: keyboard access, collapsed focus, ring labels, error recovery/backoff, independent sources, duplicate refreshes, 3 themes × 3 widths.');
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
