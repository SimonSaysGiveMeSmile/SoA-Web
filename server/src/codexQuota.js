// Documented Codex app-server account/rateLimits/read. No model turn is started.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

function normalize(raw, now = Date.now()) {
    const report = raw?.rateLimitsByLimitId?.codex || raw?.rateLimits;
    if (!report || typeof report !== 'object') throw new Error('No Codex rate-limit report');
    // Notifications can concern a different model's metered bucket. Do not
    // replace the account's Codex windows with another bucket's percentages.
    if (report.limitId && report.limitId !== 'codex') throw new Error('Not the Codex quota bucket');
    const windows = { session: null, weekly: null };
    const windowStatus = { session: 'not-reported', weekly: 'not-reported' };
    for (const w of [report.primary, report.secondary]) {
        if (!w || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100 ||
            !Number.isFinite(w.windowDurationMins) || w.windowDurationMins <= 0) continue;
        const key = w.windowDurationMins >= 10080 ? 'weekly' : 'session';
        // The official schema permits a reported percentage without a reset
        // timestamp. Preserve that value; absence of a whole window is different.
        if (w.resetsAt !== null && (!Number.isFinite(w.resetsAt) || w.resetsAt <= 0)) continue;
        if (w.resetsAt !== null && w.resetsAt * 1000 <= now) {
            windowStatus[key] = 'expired'; continue;
        }
        windows[key] = { usedPercent: w.usedPercent, windowMinutes: w.windowDurationMins,
            resetsAt: w.resetsAt === null ? null : w.resetsAt * 1000, updatedAt: now };
        windowStatus[key] = 'reported';
    }
    return { source: 'codex-app-server', windows, windowStatus, updatedAt: now, available: true, status: 'ready' };
}

class CodexQuota {
    constructor({ command, spawnProcess = spawn, now = Date.now, refreshMs = 15000, timeoutMs = 6000, env, isolated = false, onNotification } = {}) {
        const local = path.join(os.homedir(), '.local/bin/codex');
        this.command = command || process.env.SOA_CODEX_BIN || (fs.existsSync(local) ? local : 'codex');
        this.spawnProcess = spawnProcess; this.now = now; this.refreshMs = refreshMs; this.timeoutMs = timeoutMs;
        this.child = null; this.pending = null; this.current = null; this.attemptAt = 0; this.nextId = 1;
        this.requests = new Map(); this.failed = false;
        this.env = env; this.isolated = isolated; this.onNotification = onNotification;
    }
    _request(method, params) {
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            const timer = setTimeout(() => { this.requests.delete(id); reject(new Error('Quota request timed out')); }, this.timeoutMs);
            this.requests.set(id, { resolve, reject, timer });
            this.child.stdin.write(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }) + '\n', error => {
                if (error) { clearTimeout(timer); this.requests.delete(id); reject(error); }
            });
        });
    }
    async _connect() {
        if (this.connecting) return this.connecting;
        this.connecting = this._open().finally(() => { this.connecting = null; });
        return this.connecting;
    }
    async _open() {
        if (this.child) return;
        const args = ['app-server', ...(this.isolated ? ['-c', 'cli_auth_credentials_store="file"'] : [])];
        const child = this.spawnProcess(this.command, args, { stdio: ['pipe', 'pipe', 'ignore'], ...(this.env ? { env: this.env } : {}) });
        this.child = child;
        const lines = readline.createInterface({ input: child.stdout });
        const fail = () => {
            if (this.child !== child) return;
            this.child = null;
            lines.close();
            for (const p of this.requests.values()) { clearTimeout(p.timer); p.reject(new Error('Codex quota connection closed')); }
            this.requests.clear();
        };
        child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail);
        lines.on('line', line => {
            let msg; try { msg = JSON.parse(line); } catch (_) { return; }
            if (msg.method) this.onNotification?.(msg.method, msg.params);
            if (msg.method === 'account/rateLimits/updated') {
                try { this.current = normalize(msg.params, this.now()); this.failed = false; } catch (_) {}
            }
            const p = this.requests.get(msg.id);
            if (!p) return;
            clearTimeout(p.timer); this.requests.delete(msg.id);
            if (msg.error) p.reject(new Error('Codex quota request rejected')); else p.resolve(msg.result);
        });
        await this._request('initialize', { clientInfo: { name: 'soa_usage_monitor', title: 'SoA Usage Monitor', version: '1.0.0' } });
        child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    }
    async refresh() {
        if (this.pending) return this.pending;
        if (this.attemptAt && this.now() - this.attemptAt < this.refreshMs) return this.snapshot(false);
        this.attemptAt = this.now();
        this.pending = (async () => {
            try {
                await this._connect();
                this.current = normalize(await this._request('account/rateLimits/read'), this.now());
                this.failed = false;
            } catch (_) { this.failed = true; this.close(); }
            finally { this.pending = null; }
            return this.snapshot(false);
        })();
        return this.pending;
    }
    async account() { await this._connect(); return (await this._request('account/read', { refreshToken: false }))?.account || null; }
    async login() { await this._connect(); return this._request('account/login/start', { type: 'chatgptDeviceCode' }); }
    async cancelLogin(loginId) { if (this.child && loginId) await this._request('account/login/cancel', { loginId }).catch(() => {}); }
    snapshot(refresh = true) {
        if (refresh) void this.refresh();
        const now = this.now(), data = this.current;
        const windowStatus = { session: 'not-reported', weekly: 'not-reported', ...data?.windowStatus };
        const windows = Object.fromEntries(['session', 'weekly'].map(key => {
            const w = data?.windows[key];
            if (w && w.resetsAt !== null && w.resetsAt <= now) { windowStatus[key] = 'expired'; return [key, null]; }
            return [key, w || null];
        }));
        return { source: 'codex-app-server', primaryWindow: 'weekly', available: !!data, updatedAt: data?.updatedAt || null,
            status: this.failed ? 'unavailable' : !data ? 'waiting' : now - data.updatedAt > 60000 ? 'stale' : 'ready',
            windows, windowStatus };
    }
    close() { const child = this.child; this.child = null; if (child) { child.stdin.end(); child.kill('SIGTERM'); }
        for (const p of this.requests.values()) { clearTimeout(p.timer); p.reject(new Error('Quota reader closed')); } this.requests.clear(); }
}
module.exports = { CodexQuota, normalize };
