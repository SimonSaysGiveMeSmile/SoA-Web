// Saved local account profiles. Credentials belong to each provider's native
// CLI store, never to the browser, preferences JSON, or quota response.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { STATE_DIR } = require('./stateDir');
const { ClaudeQuota, readCredentials } = require('./claudeQuota');
const { CodexQuota } = require('./codexQuota');
const { QuotaPace } = require('./quotaPace');
const run = promisify(execFile);
const MAX_ACCOUNTS = 100;
const ID = /^(?:local-(?:claude|codex)|[a-f0-9-]{36})$/;
const LOGIN_MS = 10 * 60000;
const empty = () => ({ available: false, status: 'waiting', windows: {}, windowStatus: {} });
const clean = (v, max = 100) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';
function json(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
function save(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.' + crypto.randomUUID();
    try { fs.writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
    finally { try { fs.unlinkSync(temp); } catch (_) {} }
}
function loginURL(value, provider) {
    try {
        const u = new URL(value);
        const hosts = provider === 'codex' ? ['auth.openai.com', 'auth.chatgpt.com', 'chatgpt.com'] :
            ['claude.ai', 'claude.com', 'console.anthropic.com', 'platform.claude.com', 'auth.anthropic.com'];
        return u.protocol === 'https:' && !u.username && !u.password && hosts.includes(u.hostname) ? u.href : null;
    } catch (_) { return null; }
}
function accountEnv(provider, home) {
    const env = { ...process.env };
    // A profile must not accidentally use the daemon's API key or another CLI login.
    for (const key of Object.keys(env)) if (/^(?:ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR|CLAUDE_CODE_USE_|OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_HOME|CODEX_API_KEY)/.test(key)) delete env[key];
    env[provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] = home;
    return env;
}

class NativeAccount {
    constructor(profile, directory, { now = Date.now, spawnProcess = spawn, runCommand = run } = {}) {
        this.profile = profile; this.directory = directory; this.now = now;
        this.spawn = spawnProcess; this.run = runCommand; this.closed = false;
        this.home = profile.system ? path.join(os.homedir(), profile.provider === 'claude' ? '.claude' : '.codex') : path.join(directory, 'cli');
        this.env = profile.system ? { ...process.env } : accountEnv(profile.provider, this.home);
        this.connection = { state: 'checking' }; this.loginState = null; this.identity = null; this.identityAt = 0;
        this.claude = process.env.SOA_CLAUDE_BIN || path.join(os.homedir(), '.local/bin/claude');
        if (profile.provider === 'codex') {
            this.reader = new CodexQuota({ env: this.env, isolated: !profile.system, now, spawnProcess: this.spawn,
                onNotification: (method, params) => {
                    if (method === 'account/login/completed' && this.loginState && params?.loginId === this.loginState.loginId) {
                        if (params.success) { this.loginState = null; this.identityAt = 0; this.reader.attemptAt = 0; void this.refresh().catch(() => {}); }
                        else { this.loginState = { state: 'error', message: 'Sign-in did not finish. Try again.' }; }
                    }
                    if (method === 'account/updated') this.identityAt = 0;
                } });
        } else {
            this.records = profile.system ? path.join(STATE_DIR, 'claude-quota') : path.join(directory, 'records');
            this.reader = new ClaudeQuota({ directory: this.records, now, sessionMode: 'auto', preferOfficial: true,
                credentials: cb => readCredentials(cb, profile.system ? null : this.home) });
        }
    }
    async identify() {
        if (this.identityAt && this.now() - this.identityAt < 60000) return;
        this.identityAt = this.now();
        let info;
        if (this.profile.provider === 'codex') {
            const a = await this.reader.account();
            if (a?.type === 'chatgpt') info = { email: clean(a.email), plan: clean(a.planType, 40), nativeId: clean(a.id || a.accountId || a.email), workspace: clean(a.workspaceId) };
        } else {
            let stdout;
            try { ({ stdout } = await this.run(this.claude, ['auth', 'status', '--json'], { env: this.env, timeout: 8000, maxBuffer: 65536 })); }
            catch (e) { stdout = e.stdout; }
            let a; try { a = JSON.parse(stdout); } catch (_) {}
            if (a?.loggedIn && a.authMethod === 'claude.ai') info = { email: clean(a.email), plan: clean(a.subscriptionType, 40), nativeId: clean(a.accountUuid || a.email), workspace: clean(a.orgId || a.organizationId) };
        }
        const identity = info ? crypto.createHash('sha256').update(JSON.stringify([this.profile.provider, info.nativeId, info.email, info.workspace])).digest('hex') : null;
        if (!this.profile.system && identity) {
            const file = path.join(this.directory, 'identity.json');
            const expected = json(file, null);
            if (expected && expected.identity !== identity) {
                this.connection = { state: 'reconnect', message: 'This profile belongs to another account. Reconnect the original login, or add a new account.' };
                this.reader.current = null; this.reader.official = null; return;
            }
            if (!expected) save(file, { identity });
        }
        if (identity !== this.identity) this.reader.minRecordAt = this.now();
        if (this.identity && identity !== this.identity) {
            // Never reuse the previous login's readings after account switching.
            this.reader.current = null; this.reader.official = null; this.reader.attemptAt = 0;
        }
        this.identity = identity;
        this.connection = info ? { state: 'connected', email: info.email, plan: info.plan, identity } : { state: 'sign-in-required' };
    }
    async refresh() {
        if (this.closed) return;
        await this.identify();
        if (this.closed || this.connection.state !== 'connected') return;
        await this.reader.refresh();
        if (this.profile.provider === 'claude' && /expired|unauthorized/.test(this.reader.lastError || '')) {
            this.connection = { ...this.connection, state: 'reconnect', message: 'Open this CLI profile to refresh its login, or reconnect.' };
        }
    }
    snapshot() {
        if (this.loginState?.expiresAt && this.now() >= this.loginState.expiresAt) void this.cancel();
        const data = this.connection.state === 'sign-in-required' ? empty() : this.reader.snapshot(false);
        return { ...data, connection: this.connection, identity: this.identity };
    }
    publicLogin() {
        if (!this.loginState) return null;
        const { state, url, code, expiresAt, message } = this.loginState;
        return { state, url, code, expiresAt, message };
    }
    async login() {
        if (this.profile.system) throw new Error('Add a separate account to sign in; the local CLI login is managed in your terminal.');
        if (this.loginState?.state === 'pending' && this.loginState.expiresAt > this.now()) return this.publicLogin();
        await this.cancel();
        fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
        this.loginState = { state: 'pending', expiresAt: this.now() + LOGIN_MS };
        if (this.profile.provider === 'codex') {
            try {
                const result = await this.reader.login();
                const url = loginURL(result.verificationUrl, 'codex');
                if (!url || !result.loginId || typeof result.userCode !== 'string') throw new Error('Invalid sign-in response');
                this.loginState = { ...this.loginState, loginId: result.loginId, url, code: clean(result.userCode, 100) };
            } catch (_) { this.loginState = { state: 'error', message: 'Unable to start Codex sign-in. Retry, or check the installed CLI.' }; }
        } else {
            // The unmodified CLI performs login, callback/code exchange and native
            // credential storage. The dashboard only relays its sign-in ceremony.
            const hook = path.resolve(__dirname, '../../scripts/soa-quota-statusline.cjs');
            const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";
            const settingsPath = path.join(this.home, 'settings.json');
            const settings = json(settingsPath, {});
            settings.statusLine = { type: 'command', command: [process.execPath, hook, this.records].map(quote).join(' ') };
            save(settingsPath, settings);
            const browser = path.resolve(__dirname, '../../scripts/soa-quota-open-url');
            const child = this.spawn(this.claude, ['auth', 'login', '--claudeai'], {
                cwd: this.home, env: { ...this.env, BROWSER: browser }, stdio: ['pipe', 'pipe', 'pipe'] });
            this.loginChild = child;
            let output = '';
            const consume = chunk => {
                if (this.loginChild !== child) return;
                output = (output + String(chunk)).slice(-32768).replace(/\x1b\[[0-9;]*m/g, '');
                const urls = output.match(/https:\/\/[^\s<>"\x1b]+/g) || [];
                for (const value of urls) { const url = loginURL(value, 'claude'); if (url) this.loginState.url = url; }
            };
            child.stdout.on('data', consume); child.stderr.on('data', consume);
            child.once('error', () => { if (this.loginChild === child) this.loginState = { state: 'error', message: 'Claude CLI could not start.' }; });
            child.once('exit', code => {
                if (this.loginChild !== child) return;
                this.loginChild = null; output = '';
                this.loginState = code === 0 ? null : { state: 'error', message: 'Sign-in did not finish. Try again.' };
                if (code === 0) { this.identityAt = 0; this.reader.attemptAt = 0; void this.refresh().catch(() => {}); }
            });
        }
        clearTimeout(this.loginTimer);
        this.loginTimer = setTimeout(() => void this.cancel(), LOGIN_MS); this.loginTimer.unref();
        return this.publicLogin();
    }
    code(value) {
        if (!this.loginChild || this.loginState?.state !== 'pending') throw new Error('No Claude sign-in is waiting.');
        if (typeof value !== 'string' || !/^[A-Za-z0-9_#./+=:-]{6,4096}$/.test(value.trim())) throw new Error('Paste the code shown by Claude.');
        this.loginChild.stdin.write(value.trim() + '\n');
    }
    async cancel() {
        clearTimeout(this.loginTimer);
        const state = this.loginState; this.loginState = null;
        const child = this.loginChild; this.loginChild = null; child?.kill('SIGTERM');
        if (this.profile.provider === 'codex') await this.reader.cancelLogin(state?.loginId);
    }
    close() { this.closed = true; void this.cancel(); this.reader.close(); }
}

class QuotaAccounts {
    constructor({ directory = path.join(STATE_DIR, 'quota-accounts'), factory = (p, d) => new NativeAccount(p, d), now = Date.now } = {}) {
        this.directory = directory; this.file = path.join(directory, 'accounts.json'); this.factory = factory; this.now = now;
        this.readers = new Map(); this.cache = new Map(); this.pace = new QuotaPace(); this.pending = null; this.closed = false;
        this.config = json(this.file, null);
        if (!this.config) {
            this.config = { version: 1, monitoring: true, accounts: ['claude', 'codex'].map(provider => ({ id: 'local-' + provider, provider,
                label: provider === 'claude' ? 'Claude' : 'Codex', system: true, enabled: true, visible: true })) };
            save(this.file, this.config);
        }
        if (this.config.version !== 1 || typeof this.config.monitoring !== 'boolean' || !Array.isArray(this.config.accounts) || this.config.accounts.length > MAX_ACCOUNTS ||
            this.config.accounts.some(a => !ID.test(a.id) || !['claude', 'codex'].includes(a.provider) || typeof a.enabled !== 'boolean' || typeof a.visible !== 'boolean') ||
            new Set(this.config.accounts.map(a => a.id)).size !== this.config.accounts.length) throw new Error('Invalid saved quota account configuration; restore its backup.');
        for (const a of this.config.accounts) { try { const c = json(path.join(directory, a.id, 'reading.json'), null); if (c) this.cache.set(a.id, c); } catch (_) {} }
    }
    account(id) { const a = this.config.accounts.find(p => p.id === id); if (!a) throw new Error('Account not found'); return a; }
    persist() { this.config.revision = (this.config.revision || 0) + 1; save(this.file, this.config); }
    reader(a) {
        if (!this.readers.has(a.id)) this.readers.set(a.id, this.factory(a, path.join(this.directory, a.id)));
        return this.readers.get(a.id);
    }
    report(id) {
        const report = this.readers.get(id)?.snapshot() || this.cache.get(id) || empty();
        const previous = this.cache.get(id);
        // Resuming/restarting during a provider outage retains a labelled cache
        // only after the native CLI confirms it is still the same account.
        if (!report.available && !report.official?.ok && report.connection?.state === 'connected' &&
            report.identity && previous?.identity === report.identity && previous.available) {
            return { ...report, windows: previous.windows, windowStatus: previous.windowStatus,
                updatedAt: previous.updatedAt, available: true, status: 'stale' };
        }
        return report;
    }
    stop(id) { const r = this.readers.get(id); if (r) { this.cache.set(id, this.report(id)); r.close(); this.readers.delete(id); } }
    create({ provider, label }) {
        if (!['claude', 'codex'].includes(provider)) throw new Error('Choose Claude or Codex');
        if (this.config.accounts.length >= MAX_ACCOUNTS) throw new Error(`Up to ${MAX_ACCOUNTS} accounts can be saved.`);
        if (typeof label !== 'string' || !clean(label, 48).trim()) throw new Error('Give this account a name');
        const a = { id: crypto.randomUUID(), provider, label: clean(label, 48).trim(), enabled: true, visible: false, system: false };
        this.config.accounts.push(a); this.persist(); return a;
    }
    update(id, changes) {
        const a = this.account(id);
        for (const k of ['enabled', 'visible']) if (k in changes && typeof changes[k] !== 'boolean') throw new Error('Invalid account setting');
        if ('label' in changes && (typeof changes.label !== 'string' || !clean(changes.label, 48).trim())) throw new Error('Give this account a name');
        const next = { ...a, ...Object.fromEntries(['enabled', 'visible'].filter(k => k in changes).map(k => [k, changes[k]])) };
        if ('label' in changes) next.label = clean(changes.label, 48).trim();
        Object.assign(a, next); this.persist();
        if (!a.enabled) this.stop(id);
        return a;
    }
    monitoring(enabled) {
        if (typeof enabled !== 'boolean') throw new Error('Invalid monitoring setting');
        this.config.monitoring = enabled; this.persist();
        if (!enabled) for (const id of [...this.readers.keys()]) this.stop(id);
    }
    remove(id) {
        const a = this.account(id);
        if (a.system) throw new Error('The two local CLI entries can be hidden or paused.');
        this.stop(id); this.config.accounts = this.config.accounts.filter(a => a.id !== id); this.persist();
        this.cache.delete(id);
        // Native credentials are intentionally retained; removing a card does not
        // revoke a provider login or touch other sessions. Forget is separate.
    }
    async refresh() {
        if (this.closed || !this.config.monitoring) return;
        if (this.pending) return this.pending;
        const queue = this.config.accounts.filter(a => a.enabled);
        this.pending = (async () => {
            const worker = async () => {
                while (queue.length && !this.closed && this.config.monitoring) {
                    const a = queue.shift(); if (!a.enabled || !this.config.accounts.includes(a)) continue;
                    const reader = this.reader(a);
                    try {
                        await reader.refresh();
                        if (this.closed || !a.enabled || this.readers.get(a.id) !== reader) continue;
                        const value = this.report(a.id); this.cache.set(a.id, value);
                        // Public metadata and usage only; login URLs/codes are ephemeral.
                        const { login, ...persist } = value;
                        save(path.join(this.directory, a.id, 'reading.json'), persist);
                    } catch (_) { if (this.readers.get(a.id) === reader) this.cache.set(a.id, { ...this.cache.get(a.id), status: 'unavailable' }); }
                }
            };
            await Promise.all([worker(), worker()]);
        })().finally(() => { this.pending = null; });
        return this.pending;
    }
    snapshot() {
        return { monitoring: this.config.monitoring, maxAccounts: MAX_ACCOUNTS, revision: this.config.revision || 0,
            accounts: this.config.accounts.map(a => {
                const reader = this.readers.get(a.id);
                const report = this.report(a.id);
                const paused = !this.config.monitoring || !a.enabled;
                const status = paused ? 'paused' : report.updatedAt && this.now() - report.updatedAt > 300000 ? 'stale' : report.status;
                const data = { ...report, status };
                const pace = Object.fromEntries(['session', 'weekly'].map(k => [k, paused ? { state: 'paused' } : this.pace.window(a.id + ':' + (report.identity || 'unknown'), k, data, this.now())]));
                return { ...a, quota: { ...data, pace }, login: reader?.publicLogin?.() || null };
            }) };
    }
    async action(id, action, body) {
        const a = this.account(id);
        if (action === 'update') return this.update(id, body);
        if (action === 'remove') return this.remove(id);
        if (action === 'cancel') return this.readers.get(id)?.cancel();
        if (!this.config.monitoring || !a.enabled) throw new Error('Enable monitoring before connecting this account.');
        if (action === 'login') return this.reader(a).login();
        if (action === 'code') return this.reader(a).code(body.code);
        if (action === 'check') { const r = this.reader(a); r.identityAt = 0; await r.refresh(); return; }
        throw new Error('Unknown action');
    }
    close() { this.closed = true; for (const id of [...this.readers.keys()]) this.stop(id); }
}
module.exports = { QuotaAccounts, NativeAccount, loginURL, accountEnv, MAX_ACCOUNTS };
