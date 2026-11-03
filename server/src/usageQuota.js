// Usage reads and saved-account controls behind SoA's authenticated local proxy.
// Deploy independently of the terminal daemon so live PTYs stay connected.
const http = require('node:http');
const claudeSource = require('./claudeQuota');
const { CodexQuota } = require('./codexQuota');
const { QuotaPace } = require('./quotaPace');
const { CodexCosts } = require('./codexCosts');
const { QuotaAccounts } = require('./quotaAccounts');
const crypto = require('node:crypto');

function start({ port = Number(process.env.SOA_QUOTA_PORT) || 4011, host = '127.0.0.1',
    providers, costs, accounts, pace = new QuotaPace(), sampleMs = 15000, costSampleMs = 2500 } = {}) {
    const accountStore = accounts === undefined ? (providers ? null : new QuotaAccounts()) : accounts;
    const actionToken = crypto.randomBytes(32).toString('hex');
    const readers = providers || (accountStore ? {} : {
        claude: claudeSource.ClaudeQuota ? new claudeSource.ClaudeQuota() : claudeSource,
        codex: new CodexQuota(),
    });
    let costReader = costs === undefined ? (providers ? null : new CodexCosts()) : costs;
    let closed = false, refreshing = false;
    const read = (snapshot = accountStore?.snapshot()) => accountStore ? Object.fromEntries(['claude', 'codex'].map(provider => {
        const quota = snapshot.accounts.find(a => a.id === 'local-' + provider)?.quota || { available: false, status: 'waiting', windows: {} };
        // Legacy alert consumers must not treat a paused cached reading as live.
        return [provider, quota.status === 'paused' ? { ...quota, available: false, windows: {}, pace: {} } : quota];
    })) : pace.sample(Object.fromEntries(Object.entries(readers).map(([key, reader]) => {
        try { return [key, reader.snapshot()]; }
        catch (_) { return [key, { available: false, status: 'unavailable', windows: {} }]; }
    })));
    const sample = async () => {
        if (closed || refreshing) return;
        refreshing = true;
        try {
            if (accountStore) await accountStore.refresh();
            else await Promise.allSettled(Object.values(readers).map(reader => Promise.resolve().then(() => reader.refresh?.())));
            if (!closed) read();
        } finally { refreshing = false; }
    };
    const payload = () => {
        const snapshot = accountStore?.snapshot();
        return { ok: true, service: 'soa-usage-quota', version: 1, data: read(snapshot),
            costs: { codex: costReader?.snapshot() || null }, ...(snapshot ? { ...snapshot, actionToken } : {}) };
    };
    const server = http.createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json');
        // No CORS permission on this loopback service. Remote clients use the
        // daemon's authenticated proxy, which owns pairing and origin checks.
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const pathname = req.url?.split('?')[0];
        if (accountStore && req.method === 'POST' && pathname === '/api/usage-quota/accounts') {
            // A nonce obtained through an authenticated GET plus a non-simple
            // header prevents cross-site forms and DNS-rebinding mutations.
            if (!/^127\.0\.0\.1(?::\d+)?$|^localhost(?::\d+)?$/.test(req.headers.host || '') || req.headers['x-soa-quota-action'] !== actionToken) {
                res.writeHead(403).end(JSON.stringify({ ok: false, error: 'Reload the account panel and try again.' })); return;
            }
            // text/plain deliberately passes through the existing daemon proxy;
            // its express.json middleware otherwise consumes a JSON request body.
            if (!/^text\/plain\b/i.test(req.headers['content-type'] || '')) { res.writeHead(415).end('{"ok":false}'); return; }
            try {
                let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 8192) throw new Error('Request too large'); }
                const body = JSON.parse(raw);
                if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid request');
                if (body.action === 'create') accountStore.create(body);
                else if (body.action === 'monitoring') accountStore.monitoring(body.enabled);
                else await accountStore.action(body.id, body.action, body);
                sampleCosts();
                res.end(JSON.stringify(payload()));
                void sample();
            } catch (e) {
                const message = e instanceof SyntaxError ? 'Invalid request' : e.message;
                res.writeHead(400).end(JSON.stringify({ ok: false, error: String(message).slice(0, 180) }));
            }
            return;
        }
        if (req.method !== 'GET' || pathname !== '/api/usage-quota') {
            res.writeHead(404).end('{"ok":false}'); return;
        }
        res.end(JSON.stringify(payload()));
    });
    // Continue collecting bounded history when a browser tab closes. This is
    // a quota read, not a model turn; each provider retains its own throttle.
    const timer = setInterval(sample, sampleMs); timer.unref();
    const sampleCosts = () => {
        if (closed) return;
        if (accountStore && (!accountStore.config.monitoring || !accountStore.account('local-codex').enabled)) {
            if (costReader) { costReader.close(); costReader = null; }
            return;
        }
        if (!costReader && costs === undefined && !providers) costReader = new CodexCosts();
        if (!costReader) return;
        let session;
        try { session = accountStore ? read().codex?.windows?.session : readers.codex?.snapshot(false)?.windows?.session; } catch (_) {}
        costReader.refresh(session);
    };
    const costTimer = setInterval(sampleCosts, costSampleMs); costTimer.unref();
    sampleCosts();
    void sample();
    server.on('close', () => {
        closed = true; clearInterval(timer); clearInterval(costTimer); costReader?.close();
        for (const reader of Object.values(readers)) reader.close?.();
        accountStore?.close();
    });
    server.listen(port, host);
    return server;
}
if (require.main === module) {
    const server = start();
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close());
}
module.exports = { start };
