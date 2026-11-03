const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { QuotaAccounts, NativeAccount, accountEnv, loginURL } = require('../src/quotaAccounts');
const { start } = require('../src/usageQuota');
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-accounts-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let now = 1800000000000, active = 0, maxActive = 0;
    const made = [];
    const factory = (profile, home) => {
        const reader = { profile, home, calls: 0, closed: false, used: profile.provider === 'claude' ? 20 : 70, loginState: null,
            async refresh() { active++; maxActive = Math.max(active, maxActive); await new Promise(r => setTimeout(r, 2)); this.calls++; active--; },
            snapshot() { return { available: true, status: 'ready', updatedAt: now, identity: profile.id,
                connection: { state: 'connected', email: profile.label + '@example.test' },
                windows: { weekly: { usedPercent: this.used, windowMinutes: 10080, resetsAt: 1800000000000 + 86400000, updatedAt: now },
                    ...(profile.provider === 'claude' ? { session: { usedPercent: 93, windowMinutes: 300, resetsAt: 1800000000000 + 3600000, updatedAt: now } } : {}) } }; },
            async login() { this.loginState = { state: 'pending', url: 'https://claude.ai/oauth/authorize?state=private-login-state', code: 'temporary-device-code' }; return this.loginState; },
            publicLogin() { return this.loginState; }, cancel() { this.loginState = null; },
            close() { this.closed = true; this.cancel(); } };
        made.push(reader); return reader;
    };
    const store = new QuotaAccounts({ directory, factory, now: () => now });
    t.after(() => store.close());
    return { store, directory, made, factory, advance: n => { now += n; }, max: () => maxActive };
}
test('two defaults, 12+ isolated accounts and preferences survive service recreation', async t => {
    const f = fixture(t); assert.equal(f.store.snapshot().accounts.length, 2);
    for (let i = 0; i < 12; i++) f.store.create({ provider: i % 2 ? 'codex' : 'claude', label: 'Account ' + i });
    const account = f.store.config.accounts[2];
    assert.equal(account.visible, false);
    f.store.update(account.id, { visible: true, enabled: false, label: 'Personal' });
    await f.store.refresh(); assert.ok(f.max() <= 2);
    assert.equal(new Set(f.made.map(r => r.home)).size, f.made.length);
    f.store.close();
    const next = new QuotaAccounts({ directory: f.directory, factory: f.factory }); t.after(() => next.close());
    assert.equal(next.snapshot().accounts.length, 14);
    assert.deepEqual(next.account(account.id), { ...account, label: 'Personal', enabled: false, visible: true });
    assert.equal(fs.statSync(path.join(f.directory, 'accounts.json')).mode & 0o777, 0o600);
});
test('hide retains collection; pause closes collectors and resume retains profile', async t => {
    const f = fixture(t); await f.store.refresh(); const reader = f.made[0];
    f.store.update('local-claude', { visible: false }); await f.store.refresh(); assert.equal(reader.closed, false); assert.equal(reader.calls, 2);
    f.store.update('local-claude', { enabled: false }); assert.equal(reader.closed, true); await f.store.refresh(); assert.equal(reader.calls, 2);
    assert.equal(f.store.snapshot().accounts[0].quota.status, 'paused');
    f.store.monitoring(false); const calls = f.made.reduce((n, r) => n + r.calls, 0); await f.store.refresh();
    assert.equal(f.made.reduce((n, r) => n + r.calls, 0), calls); assert.ok(f.made.every(r => r.closed));
    f.store.monitoring(true); f.store.update('local-claude', { enabled: true }); await f.store.refresh(); assert.equal(f.store.snapshot().accounts[0].visible, false);
});
test('same-provider percentages, pace, and session availability remain independent', async t => {
    const f = fixture(t), a = f.store.create({ provider: 'claude', label: 'Second' });
    await f.store.refresh(); f.store.snapshot();
    f.advance(180000); f.made.find(r => r.profile.id === a.id).used = 60; await f.store.refresh();
    const data = f.store.snapshot().accounts;
    assert.equal(data[0].quota.windows.weekly.usedPercent, 20); assert.equal(data[2].quota.windows.weekly.usedPercent, 60);
    assert.equal(data[0].quota.pace.weekly.state, 'steady'); assert.equal(data[2].quota.pace.weekly.state, 'estimated');
    assert.ok(data[0].quota.windows.session); assert.equal(data[1].quota.windows.session, undefined);
});
test('pause during refresh discards in-flight readings and closes the child', async t => {
    const f = fixture(t); const pending = f.store.refresh(); f.store.monitoring(false); await pending;
    assert.equal(f.store.readers.size, 0); assert.ok(f.store.snapshot().accounts.every(a => a.quota.status === 'paused'));
});
test('sign-in state is ephemeral; hiding and pausing never deletes CLI credential files', async t => {
    const f = fixture(t), a = f.store.create({ provider: 'claude', label: 'Saved' });
    const home = path.join(f.directory, a.id, 'cli'); fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, '.credentials.json'), 'native-owned-fixture');
    await f.store.action(a.id, 'login', {}); await f.store.refresh();
    assert.ok(f.store.snapshot().accounts.find(x => x.id === a.id).login.url);
    const persisted = fs.readFileSync(path.join(f.directory, a.id, 'reading.json'), 'utf8'); assert.doesNotMatch(persisted, /temporary-device-code|private-login-state/);
    f.store.update(a.id, { enabled: false, visible: false }); f.store.close();
    assert.equal(fs.readFileSync(path.join(home, '.credentials.json'), 'utf8'), 'native-owned-fixture');
});
test('invalid profile inputs cannot select arbitrary paths or providers', t => {
    const { store } = fixture(t);
    assert.throws(() => store.create({ provider: '../x', label: 'x' }));
    assert.throws(() => store.update('../../session.json', { visible: true }));
    assert.throws(() => store.update('local-claude', { enabled: 'false' }));
    assert.throws(() => store.remove('local-claude'));
    const a = store.create({ provider: 'claude', label: 'safe', system: true, home: '/tmp/unowned' });
    assert.equal(a.system, false); assert.equal(a.home, undefined);
});
test('login URLs and child environments stay provider scoped', () => {
    assert.equal(loginURL('https://claude.ai.evil.test/oauth', 'claude'), null);
    assert.equal(loginURL('javascript:alert(1)', 'codex'), null);
    assert.equal(loginURL('https://user:pass@claude.ai/', 'claude'), null);
    assert.equal(loginURL('https://auth.openai.com/codex/device', 'codex'), 'https://auth.openai.com/codex/device');
    const env = accountEnv('claude', '/tmp/profile'); assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/profile'); assert.equal(env.ANTHROPIC_API_KEY, undefined);
});
test('HTTP writes require the nonce and survive the existing text proxy contract', async t => {
    const f = fixture(t); const server = start({ port: 0, accounts: f.store, costs: null, sampleMs: 100000 });
    await new Promise(r => server.once('listening', r)); t.after(() => new Promise(r => server.close(r)));
    const base = `http://127.0.0.1:${server.address().port}/api/usage-quota`;
    const first = await (await fetch(base)).json(); assert.equal(first.version, 1); assert.ok(first.data.claude); assert.equal(first.accounts.length, 2);
    let response = await fetch(base + '/accounts', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"action":"monitoring","enabled":false}' }); assert.equal(response.status, 403);
    const headers = { 'content-type': 'text/plain', 'x-soa-quota-action': first.actionToken };
    response = await fetch(base + '/accounts', { method: 'POST', headers, body: JSON.stringify({ action: 'create', provider: 'claude', label: 'Third' }) });
    const body = await response.json(); assert.equal(response.status, 200); assert.equal(body.accounts.length, 3);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    const forbidden = await new Promise(resolve => { const req = http.request(base + '/accounts', { method: 'POST', headers: { ...headers, host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.end('{}'); }); assert.equal(forbidden, 403);
    response = await fetch(base + '/accounts', { method: 'POST', headers, body: JSON.stringify({ action: 'monitoring', enabled: false }) });
    const paused = await response.json();
    assert.equal(paused.monitoring, false);
    assert.equal(paused.data.claude.available, false);
    assert.deepEqual(paused.data.claude.windows, {});
    assert.equal(paused.accounts[0].quota.status, 'paused');
    assert.ok(paused.accounts[0].quota.windows.weekly);
    assert.equal((await fetch(base + '/accounts', { method: 'OPTIONS' })).status, 404);
});
test('Claude native login identities cannot silently switch a saved profile to another account', async t => {
    const f = fixture(t), a = f.store.create({ provider: 'claude', label: 'Bound' }); let email = 'first@example.test';
    const reader = new NativeAccount(a, path.join(f.directory, a.id), { runCommand: async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email }) }) });
    t.after(() => reader.close()); await reader.identify(); assert.equal(reader.connection.state, 'connected');
    reader.identityAt = 0; email = 'other@example.test'; await reader.identify(); assert.equal(reader.connection.state, 'reconnect');
    assert.equal(reader.snapshot().windows.weekly, null);
});

test('native Claude sign-in relays only a provider URL/code and leaves its credential store to the CLI', async t => {
    const f = fixture(t), a = f.store.create({ provider: 'claude', label: 'Native test' });
    let child, invocation, authenticated = false;
    const reader = new NativeAccount(a, path.join(f.directory, a.id), {
        spawnProcess(command, args, options) {
            invocation = { command, args, options };
            child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
            child.stdin = new Writable({ write(chunk, enc, done) { assert.equal(String(chunk), 'native-test-code\n'); authenticated = true; done(); child.emit('exit', 0); } });
            child.kill = () => { child.emit('exit', 1); };
            return child;
        },
        runCommand: async () => ({ stdout: JSON.stringify({ loggedIn: authenticated, authMethod: 'claude.ai', email: 'test@example.test' }) }),
    });
    t.after(() => reader.close());
    // This test validates auth, not the external usage endpoint.
    reader.reader.refresh = async () => {};
    await reader.login();
    assert.deepEqual(invocation.args, ['auth', 'login', '--claudeai']);
    assert.equal(invocation.options.env.CLAUDE_CONFIG_DIR, path.join(f.directory, a.id, 'cli'));
    child.stdout.write('Opening browser to sign in…\nIf the browser did not open, visit: https://claude.com/oauth/authorize?state=fixture\nPaste code here if prompted > ');
    assert.equal(reader.publicLogin().url, 'https://claude.com/oauth/authorize?state=fixture');
    assert.throws(() => reader.code('bad\ncommand'));
    reader.code('native-test-code'); await new Promise(r => setImmediate(r));
    assert.equal(reader.connection.state, 'connected'); assert.equal(reader.publicLogin(), null);
    const settings = JSON.parse(fs.readFileSync(path.join(f.directory, a.id, 'cli/settings.json')));
    assert.ok(settings.statusLine.command.includes(path.join(f.directory, a.id, 'records')));
    assert.equal(fs.existsSync(path.join(f.directory, a.id, 'cli/.credentials.json')), false);
});

test('native Codex device-code login uses its isolated home, never starts a model turn, and cancels cleanly', async t => {
    const f = fixture(t), a = f.store.create({ provider: 'codex', label: 'Codex test' });
    const methods = []; let child, options;
    const reader = new NativeAccount(a, path.join(f.directory, a.id), {
        spawnProcess(command, args, opts) {
            options = opts; assert.ok(args.includes('cli_auth_credentials_store="file"'));
            child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
            child.stdin = new Writable({ write(chunk, enc, done) {
                const message = JSON.parse(String(chunk)); methods.push(message.method);
                const result = message.method === 'account/login/start' ? { loginId: 'login-test', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-1234' } :
                    message.method === 'account/read' ? { account: null } : {};
                if (message.id) setImmediate(() => child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n'));
                done();
            } });
            child.kill = () => child.emit('exit', 0);
            return child;
        },
    });
    t.after(() => reader.close()); await reader.login();
    assert.equal(options.env.CODEX_HOME, path.join(f.directory, a.id, 'cli'));
    assert.equal(reader.publicLogin().code, 'TEST-1234');
    await reader.cancel(); assert.ok(methods.includes('account/login/cancel'));
    assert.ok(methods.every(m => !m.startsWith('thread/') && !m.startsWith('turn/')));
    assert.equal(reader.publicLogin(), null);
});
