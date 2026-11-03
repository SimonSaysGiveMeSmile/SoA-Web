// Isolated end-to-end check. No real credentials, agent sessions or quota APIs.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const engine = process.env.SOA_TEST_BROWSER || 'chromium';
const browserType = require(process.env.PLAYWRIGHT_MODULE || 'playwright')[engine];
const express = require(process.env.EXPRESS_MODULE || 'express');
const { mount } = require(process.env.SOA_PREVIEW_MODULE || '../server/src/preview');
const { QuotaAccounts } = require('../server/src/quotaAccounts');
const { start } = require('../server/src/usageQuota');
const root = path.resolve(__dirname, '..');
const candidate = process.env.SOA_CANDIDATE_PUBLIC || path.join(root, 'web/public');
const installed = process.env.SOA_INSTALLED_PUBLIC || path.join(root, 'web/public');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-account-ui-'));
let browser, front, quota;
const readers = new Map();
const factory = (a, directory) => {
    const stateFile = path.join(directory, 'native-fixture.json');
    let connected = a.system || fs.existsSync(stateFile), login = null;
    const reader = {
        calls: 0, closed: false,
        async refresh() { this.calls++; },
        snapshot() { const now = Date.now(); return { available: connected, status: connected ? 'ready' : 'waiting', updatedAt: connected ? now : null,
            identity: a.id, connection: { state: connected ? 'connected' : 'sign-in-required', email: connected ? `${a.provider}@example.test` : '', plan: a.provider === 'claude' ? 'Max' : 'Pro' },
            windows: connected ? { weekly: { usedPercent: a.provider === 'claude' ? 38 : 85, windowMinutes: 10080, resetsAt: now + 86400000 * 3, updatedAt: now },
                ...(a.provider === 'claude' ? { session: { usedPercent: 96, windowMinutes: 300, resetsAt: now + 3600000, updatedAt: now } } : {}) } : {} }; },
        publicLogin() { return login; },
        async login() { login = { state: 'pending', url: a.provider === 'claude' ? 'https://claude.ai/oauth/authorize?state=fixture' : 'https://auth.openai.com/codex/device', ...(a.provider === 'codex' ? { code: 'TEST-1234' } : {}), expiresAt: Date.now() + 600000 }; return login; },
        code() { this.complete(); }, cancel() { login = null; },
        complete() { connected = true; login = null; fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(stateFile, 'native-fixture'); },
        close() { this.closed = true; login = null; },
    };
    readers.set(a.id, reader); return reader;
};
const store = new QuotaAccounts({ directory: path.join(tmp, 'state'), factory });
function listen(server) { return new Promise(r => server.once('listening', r)); }
function checkJSON(url, body, token) { return fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain', 'x-soa-quota-action': token }, body: JSON.stringify(body) }).then(async r => { const data = await r.json(); assert.equal(r.status, 200, JSON.stringify(data)); return data; }); }
(async () => {
    quota = start({ port: 0, accounts: store, costs: null, sampleMs: 100 }); await listen(quota);
    const qport = quota.address().port;
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { if (req.url.startsWith('/preview/4011/')) req.url = req.url.replace('/preview/4011/', '/preview/' + qport + '/'); next(); });
    mount(app, (req, res, next) => req.query.t === 'fixture-pair' ? next() : res.status(401).end());
    app.get('/api/:source-usage', (req, res) => res.json({ data: { available: true, hasData: true, updatedAt: Date.now(), seriesMinutes: 12, series: [0, 20, 50, 180, 200, 10, 15, 55, 100, 250, 60, 80], today: { cost: 14 }, week: { cost: 75 }, sessions: [], models: [], block: {} } }));
    app.get('/assets/widgets.js', (req, res) => {
        const s = fs.readFileSync(path.join(candidate, 'assets/widgets.js'), 'utf8'); res.type('js').send(s + '\nexport { ClaudeUsageWidget };');
    });
    for (const dir of [candidate, installed]) app.use(express.static(dir));
    app.get('/fixture', (req, res) => res.type('html').send(`<!doctype html><html data-ui="windows11" data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/styles.css"><link rel="stylesheet" href="/assets/sidebar.css"><link rel="stylesheet" href="/assets/minimal.css"><link rel="stylesheet" href="/assets/liquid.css"><link rel="stylesheet" href="/assets/design-packs.css"><link rel="stylesheet" href="/assets/desktop-packs.css"><style>body{display:block!important;overflow:auto!important;padding:20px;margin:0;background:#171b22;color:#dce4ec}#fixture{width:290px;max-width:100%;font:13px system-ui}*{box-sizing:border-box}</style></head><body><main id="fixture"></main><script type="module">
import { QuotaAccountsView } from '/m/quotaAccountsView.js';
window.__SOA_WEB__={backend:location.origin,_resolvedToken:'fixture-pair'};
const api=p=>p+(p.includes('?')?'&':'?')+'t=fixture-pair';
window.view=new QuotaAccountsView({parent:document.querySelector('#fixture'),api});
await view.refresh(); window.timer=setInterval(()=>view.refresh(),350); window.ready=true;
window.openPhone=async()=>{const {openQuotaAccountsSheet}=await import('/m/quotaAccounts.js');return window.phone=openQuotaAccountsSheet({api})};
window.openWidget=async()=>{clearInterval(window.timer);view.destroy();const {ClaudeUsageWidget}=await import('/assets/widgets.js');window.widget=new ClaudeUsageWidget({parent:document.querySelector('#fixture')});await widget.tick();await widget.tick();};
</script></body></html>`));
    front = app.listen(0, '127.0.0.1'); await listen(front); const origin = `http://127.0.0.1:${front.address().port}`;
    browser = await browserType.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 800, height: 950 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/fixture'); await page.waitForFunction(() => window.ready);
    await page.waitForFunction(() => document.querySelectorAll('.qa-percent')[0]?.textContent === '38%', null, {timeout:5000}).catch(async e=>{ console.error(await page.evaluate(async()=>({viewData:window.view.data, text:document.querySelector('#fixture').innerText, response:await (await fetch('/preview/4011/api/usage-quota?t=fixture-pair')).json()}))); throw e; });
    assert.equal(await page.locator('.qa-card').count(), 2);
    assert.equal(await page.locator('[data-account="local-codex"] .qa-session').isVisible(), false);
    await page.getByRole('button', { name: 'Hide Claude from panel' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.qa-card').length === 1);
    assert.equal(store.account('local-claude').enabled, true);
    await page.getByRole('button', { name: 'Choose monitored accounts' }).click();
    await page.getByLabel('Show Claude', { exact: true }).check();
    await page.getByLabel('Monitor Claude', { exact: true }).uncheck();
    await page.waitForFunction(() => document.querySelector('.qa-card[data-account="local-claude"]')?.dataset.state === 'paused');
    assert.equal(readers.get('local-claude').closed, true);
    await page.reload(); await page.waitForFunction(() => window.ready);
    assert.equal(store.account('local-claude').enabled, false);
    await page.getByRole('button', { name: 'Resume monitoring Claude' }).click();
    await page.getByRole('button', { name: 'Choose monitored accounts' }).click();
    const input = page.getByLabel('Name for Claude', { exact: true }); await input.fill('Work Claude');
    await page.waitForTimeout(800); assert.equal(await input.inputValue(), 'Work Claude'); assert.equal(await input.evaluate(n => n === document.activeElement), true);
    await input.press('Tab'); await page.waitForFunction(() => window.view.data.accounts[0].label === 'Work Claude');
    await page.getByLabel('New account name').fill('Personal Max'); await page.getByRole('button', { name: 'Add and connect account' }).click();
    await page.waitForFunction(() => document.querySelector('.qa-login:not([hidden]) a')?.getAttribute('href')?.includes('claude.ai'));
    const added = store.config.accounts.find(a => a.label === 'Personal Max'); assert.equal(added.visible, false);
    await page.getByLabel('Sign-in code for Personal Max').fill('fixture-code'); await page.getByRole('button', { name: 'Submit sign-in code' }).click();
    await page.getByLabel('Show Personal Max', { exact: true }).check();
    await page.waitForFunction(() => document.querySelectorAll('.qa-card').length === 3);
    await page.getByRole('button', { name: 'Pause all monitoring' }).click(); await page.reload(); await page.waitForFunction(() => window.ready);
    assert.equal(store.config.monitoring, false);
    await page.getByRole('button', { name: 'Resume all monitoring' }).click();
    let data = await (await fetch(origin + '/preview/4011/api/usage-quota?t=fixture-pair')).json();
    for (let i = 0; i < 10; i++) data = await checkJSON(origin + '/preview/4011/api/usage-quota/accounts?t=fixture-pair', { action: 'create', provider: i % 2 ? 'claude' : 'codex', label: 'Extra ' + i }, data.actionToken);
    await page.waitForFunction(() => window.view.data.accounts.length === 13);
    for (const width of [220, 280, 360]) {
        await page.evaluate(width => document.querySelector('#fixture').style.width = width + 'px', width);
        await page.getByRole('button', { name: 'Choose monitored accounts' }).click();
        const overflow = await page.locator('.quota-accounts').evaluate(n => n.scrollWidth > n.clientWidth + 1); assert.equal(overflow, false, 'overflow at ' + width);
        await page.screenshot({ path: path.join(tmp, 'accounts-' + width + '.png'), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => window.openPhone());
    await page.waitForSelector('dialog[open] .qa-card');
    assert.equal(await page.locator('dialog[open]').evaluate(n => n.scrollWidth > n.clientWidth + 1), false);
    await page.screenshot({ path: path.join(tmp, 'phone.png'), fullPage: true });
    await page.getByRole('button', { name: 'Done', exact: true }).click(); await page.locator('dialog').waitFor({state:'detached'});
    await page.setViewportSize({ width: 900, height: 950 }); await page.evaluate(() => window.openWidget());
    await page.waitForSelector('.quota-accounts:not([hidden]) .qa-card');
    assert.equal(await page.locator('.usage-dials').isVisible(), false);
    assert.ok(await page.locator('.qa-card').count() >= 2);
    await page.getByRole('button', { name: 'Choose monitored accounts' }).click();
    const widgetInput = page.getByLabel('Name for Work Claude'); await widgetInput.fill('Typed while polling');
    await page.evaluate(() => window.widget.tick()); assert.equal(await widgetInput.inputValue(), 'Typed while polling');
    assert.equal(await widgetInput.evaluate(n => n === document.activeElement), true);
    await page.screenshot({ path: path.join(tmp, 'widget.png'), fullPage: true });
    for (const theme of ['light', 'dark']) for (const pack of ['tron', 'minimal', 'liquid', 'brutalist', 'classic', 'dos', 'macos27', 'windows11', 'neumorphism']) {
        await page.evaluate(({theme, pack}) => { document.documentElement.dataset.theme=theme; document.documentElement.dataset.ui=pack; }, {theme,pack});
        assert.equal(await page.locator('.quota-accounts').evaluate(n => n.scrollWidth > n.clientWidth + 1), false, `${pack} ${theme} overflow`);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, engine, themes: 18, accounts: store.config.accounts.length, proxyPost: true, focusRetained: true, screenshots: tmp, browserErrors: errors }));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
    await browser?.close(); front?.closeAllConnections(); await new Promise(r => front ? front.close(r) : r());
    quota?.closeAllConnections(); await new Promise(r => quota ? quota.close(r) : r()); store.close();
});
