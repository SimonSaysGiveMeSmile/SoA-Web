// Local API-equivalent token costs. These are NOT Codex subscription charges.
// Rates verified 2026-10-05 against https://developers.openai.com/api/docs/pricing
// and /api/docs/models/gpt-6-{astra,sol,luna}. Unknown models stay unpriced.
// A worker scans history once, then tails additions; quota HTTP stays responsive.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const HOUR = 3600000, WEEK = 7 * 24 * HOUR;
const RATES = {
    'gpt-6-astra': [10, 1, 12.5, 50, 272000],
    'gpt-6.1-sol': [2, 0.1, 2.5, 10, 272000],
    'gpt-6-sol': [2, 0.2, 2.5, 10, 272000],
    'gpt-6-luna': [0.1, 0.01, 0.125, 0.5, 272000],
    'gpt-5.6-sol': [4, 0.4, 5, 20, 272000],
    'gpt-5.3-codex': [1.75, 0.175, 1.75, 14, Infinity],
};

function price(model, usage) {
    const rates = RATES[model] || RATES[String(model).replace(/-\d{4}-\d{2}-\d{2}$/, '')];
    if (!rates || !usage) return null;
    const { input_tokens: input, output_tokens: output } = usage;
    const cached = usage.cached_input_tokens ?? 0, write = usage.cache_write_input_tokens ?? 0;
    if (![input, output, cached, write].every(n => Number.isFinite(n) && n >= 0) || cached + write > input) return null;
    const long = input > rates[4];
    // Cache hits/writes are subsets of input; reasoning is already in output.
    // Always Standard API-equivalent pricing: plan/tier/tool fees are not a bill.
    return ((input - cached - write) * rates[0] + cached * rates[1] + write * rates[2]) * (long ? 2 : 1) / 1e6 +
        output * rates[3] * (long ? 1.5 : 1) / 1e6;
}

const recordType = /"type"\s*:\s*"(session_meta|turn_context|token_usage_record|event_msg)"/;
const counts = u => ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'].map(k => u?.[k] ?? 0).join(',');

class CostIndex {
    constructor({ home = process.env.SOA_CODEX_HOME || path.join(os.homedir(), '.codex') } = {}) {
        this.home = home;
        this.files = new Map();
    }
    _parse(line, c, cutoff) {
        // Test the outer record header before parsing: never retain chat/tool text.
        const kind = recordType.exec(line.slice(0, 300))?.[1];
        if (!kind || (kind === 'event_msg' && !line.includes('"token_count"'))) return;
        let row;
        try { row = JSON.parse(line); } catch (_) { c.bad = true; return; }
        const p = row.payload;
        if (!p || typeof p !== 'object') return;
        const ts = Date.parse(row.timestamp);
        if (row.type === 'session_meta') {
            c.id = p.session_id || p.id || c.id;
            c.model = p.model || p.base_instructions?.provenance?.model || c.model;
        } else if (row.type === 'turn_context') {
            if (p.model) {
                c.model = p.model;
                if (p.turn_id) c.turns.set(p.turn_id, p.model);
            }
        } else if (row.type === 'token_usage_record') {
            c.hasRecords = true;
            if (!p.usage || !Number.isFinite(ts) || ts < cutoff) return;
            const key = p.response_id ? `response:${p.response_id}` :
                `record:${p.thread_id || c.id}:${p.thread_token_usage ? counts(p.thread_token_usage) : `${ts}:${row.ordinal}`}`;
            c.records.set(key, { key, ts, cost: price(p.model || c.turns.get(p.turn_id) || c.model, p.usage) });
        } else if (row.type === 'event_msg' && p.type === 'token_count') {
            // Older Codex versions only write token_count. Repeated status
            // events reuse the same cumulative count and must not add spend.
            const info = p.info, total = info?.total_token_usage;
            if (!total) return;
            const fingerprint = counts(total);
            if (fingerprint === c.lastCount) return;
            c.lastCount = fingerprint;
            if (!info.last_token_usage || !Number.isFinite(ts) || ts < cutoff) return;
            const key = `count:${c.id}:${fingerprint}`;
            c.fallback.set(key, { key, ts, cost: price(c.turns.get(p.turn_id) || c.model, info.last_token_usage) });
        }
    }
    _tail(file, stat, cutoff) {
        let c = this.files.get(file);
        if (!c || c.ino !== stat.ino || stat.size < c.offset || (stat.size === c.offset && stat.mtimeMs !== c.mtime)) {
            c = { ino: stat.ino, offset: 0, mtime: 0, partial: '', skipping: false, model: '', id: file,
                turns: new Map(), records: new Map(), fallback: new Map(), hasRecords: false, lastCount: '', bad: false };
            this.files.set(file, c);
        }
        const fd = fs.openSync(file, 'r');
        try {
            const chunk = Buffer.allocUnsafe(256 * 1024);
            while (c.offset < stat.size) {
                const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - c.offset), c.offset);
                if (!n) break;
                // Usage/model metadata is ASCII; only discarded prose can split
                // a UTF-8 character. Keep partial lines until the writer finishes.
                const text = chunk.toString('utf8', 0, n);
                c.offset += n;
                let from = 0, at;
                while ((at = text.indexOf('\n', from)) !== -1) {
                    if (!c.skipping) this._parse(c.partial + text.slice(from, at), c, cutoff);
                    c.partial = ''; c.skipping = false; from = at + 1;
                }
                if (!c.skipping) {
                    c.partial += text.slice(from);
                    if (c.partial.length > 4 * 1024 * 1024) {
                        // Giant tool results are irrelevant. A giant usage or
                        // context record, however, makes this scan incomplete.
                        if (recordType.test(c.partial.slice(0, 300))) c.bad = true;
                        c.partial = ''; c.skipping = true;
                    }
                }
            }
            c.mtime = stat.mtimeMs;
        } finally { fs.closeSync(fd); }
        for (const stream of [c.records, c.fallback]) for (const [key, r] of stream) if (r.ts < cutoff) stream.delete(key);
        return c;
    }
    scan(now = Date.now(), session = null) {
        const cutoff = now - WEEK, seen = new Set();
        let unreadable = 0, exists = false;
        const walk = (dir, depth = 0) => {
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); exists = true; }
            catch (e) { if (e.code !== 'ENOENT') unreadable++; return; }
            for (const e of entries) {
                const file = path.join(dir, e.name);
                if (e.isDirectory() && depth < 5) { walk(file, depth + 1); continue; }
                if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
                try {
                    const stat = fs.statSync(file);
                    if (stat.mtimeMs < cutoff) continue;
                    seen.add(file); this._tail(file, stat, cutoff);
                } catch (_) { unreadable++; }
            }
        };
        walk(path.join(this.home, 'sessions')); walk(path.join(this.home, 'archived_sessions'));
        for (const file of this.files.keys()) if (!seen.has(file)) this.files.delete(file);
        const records = new Map();
        for (const c of this.files.values()) {
            if (c.bad) unreadable++;
            for (const [key, r] of c.hasRecords ? c.records : c.fallback) records.set(key, r);
        }
        const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
        const official = session?.windowMinutes === 300 && Number.isFinite(session.resetsAt) && session.resetsAt > now &&
            session.resetsAt - 5 * HOUR <= now && Number.isFinite(session.updatedAt) && now - session.updatedAt < 60000;
        const starts = { block: official ? session.resetsAt - 5 * HOUR : now - 5 * HOUR, today: midnight.getTime(), week: cutoff };
        const windows = {};
        for (const [key, start] of Object.entries(starts)) {
            let cost = 0, requests = 0, unpriced = 0;
            for (const r of records.values()) {
                if (r.ts < start || r.ts > now) continue;
                requests++;
                if (r.cost === null) unpriced++; else cost += r.cost;
            }
            windows[key] = { cost: !exists || (unpriced > 0 && unpriced === requests) || (unreadable && !requests) ? null : cost,
                start, end: now, requests, unpriced, partial: unpriced > 0 || unreadable > 0 };
        }
        return { source: 'codex-local-records', basis: 'standard-api-equivalent', pricingAsOf: '2026-10-05',
            available: exists, status: exists ? 'ready' : 'unavailable', updatedAt: now,
            blockBasis: official ? 'quota-window' : 'rolling-5h', unreadableFiles: unreadable, windows };
    }
}

class CodexCosts {
    constructor({ home, now = Date.now } = {}) {
        this.home = home; this.now = now; this.current = null; this.worker = null; this.pending = false; this.closed = false;
    }
    refresh(session = null) {
        if (this.closed || this.pending) return;
        if (!this.worker) {
            const worker = new Worker(__filename, { workerData: { codexCosts: true, home: this.home } });
            this.worker = worker;
            worker.on('message', data => {
                if (this.worker !== worker || this.closed) return;
                this.pending = false; this.current = data; worker.unref();
            });
            const fail = () => {
                if (this.worker !== worker) return;
                this.worker = null; this.pending = false;
                this.current = { ...this.current, status: 'unavailable' };
            };
            worker.on('error', fail); worker.on('exit', fail); worker.unref();
        }
        this.pending = true;
        // An outstanding scan must finish even in a short-lived CLI caller.
        // Idle workers stay unreferenced so they never prevent shutdown.
        this.worker.ref();
        this.worker.postMessage({ now: this.now(), session });
    }
    snapshot() {
        if (!this.current) return { source: 'codex-local-records', available: false, status: 'indexing', updatedAt: null, windows: {} };
        return { ...this.current, status: this.current.status === 'ready' && this.now() - this.current.updatedAt > 15000 ? 'stale' : this.current.status };
    }
    close() { this.closed = true; this.worker?.terminate(); this.worker = null; }
}

if (!isMainThread && workerData?.codexCosts) {
    const index = new CostIndex({ home: workerData.home });
    parentPort.on('message', ({ now, session }) => {
        try { parentPort.postMessage(index.scan(now, session)); }
        catch (_) { parentPort.postMessage({ source: 'codex-local-records', available: false, status: 'unavailable', updatedAt: now, windows: {} }); }
    });
}
module.exports = { CodexCosts, CostIndex, price };
