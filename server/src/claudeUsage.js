/**
 * Real-time Claude usage, computed from the local Claude Code transcripts.
 *
 * Claude Code appends every turn to ~/.claude/projects/<enc-cwd>/<id>.jsonl.
 * Each assistant line carries a `message.usage` block (input/output/cache
 * tokens), a `model`, a `timestamp`, and a `requestId` — the same fields the
 * `ccusage` tool reads. We tail those files incrementally (only the bytes
 * appended since the last poll) so a widget can poll every few seconds without
 * ever re-reading a day of history.
 *
 * From the deduped stream we derive:
 *   - the active 5-hour rolling window (Claude's usage-limit block) with the
 *     time left until it resets,
 *   - today's totals (since local midnight),
 *   - a live burn rate + linear projection to the end of the block,
 *   - a per-model breakdown, and
 *   - a per-minute token series for a sparkline.
 *
 * Cost is an ESTIMATE from Anthropic's public list prices — a Max/Pro seat
 * doesn't pay per token, but dollars are the most legible cross-model unit for
 * "how hard am I leaning on the model right now".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Rolling usage-limit window Claude Code enforces.
const BLOCK_MS = 5 * 3600 * 1000;
// How far back we retain per-record data. Needs to cover "today" in any
// timezone (up to ~24h) plus a full block; 30h is a safe margin.
const WINDOW_MS = 30 * 3600 * 1000;
// Don't re-stat/re-read more often than this; the widget polls ~4s anyway.
const MIN_RECOMPUTE_MS = 1200;
// Sparkline resolution.
const SERIES_MINUTES = 30;

// USD per token (list price ÷ 1e6). Tiers are matched by substring so new
// dated model ids inherit the right bucket automatically.
const M = 1e6;
const PRICING = {
    opus:   { in: 15 / M,  out: 75 / M, cacheWrite: 18.75 / M, cacheRead: 1.5 / M },
    sonnet: { in: 3 / M,   out: 15 / M, cacheWrite: 3.75 / M,  cacheRead: 0.30 / M },
    haiku:  { in: 0.80 / M, out: 4 / M, cacheWrite: 1.0 / M,   cacheRead: 0.08 / M },
    fable:  { in: 15 / M,  out: 75 / M, cacheWrite: 18.75 / M, cacheRead: 1.5 / M },
};
function tierOf(model) {
    const m = (model || '').toLowerCase();
    if (m.includes('opus')) return 'opus';
    if (m.includes('sonnet')) return 'sonnet';
    if (m.includes('haiku')) return 'haiku';
    if (m.includes('fable')) return 'fable';
    return 'other';
}
function priceOf(model) {
    return PRICING[tierOf(model)] || PRICING.sonnet;
}
function costOf(r) {
    const p = priceOf(r.model);
    return r.input * p.in + r.output * p.out + r.cacheCreate * p.cacheWrite + r.cacheRead * p.cacheRead;
}

// Per-file tail cache: { readOffset, records: [{ts,model,key,input,output,cacheCreate,cacheRead}] }.
// readOffset is always parked on a newline boundary so the next read starts on
// a clean line even mid-append.
const _cache = new Map();
let _lastComputed = null;
let _lastAt = 0;

function parseInto(line, out) {
    if (!line) return;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { return; }
    if (!obj || obj.type !== 'assistant') return;
    const msg = obj.message;
    if (!msg || !msg.usage) return;
    const u = msg.usage;
    const ts = Date.parse(obj.timestamp || msg.timestamp || '');
    if (!ts) return;
    out.push({
        ts,
        model: msg.model || '',
        // Dedupe key across transcripts that replay the same history on resume.
        key: (msg.id || '') + ':' + (obj.requestId || ''),
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheCreate: u.cache_creation_input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
    });
}

// List *.jsonl files touched within the retention window. Skips workflow /
// subagent transcripts so a widget reflects the human-facing conversations.
function candidateFiles(cutoff) {
    const files = [];
    let dirs;
    try { dirs = fs.readdirSync(PROJECTS_DIR); } catch (_) { return files; }
    for (const entry of dirs) {
        if (entry.startsWith('wf_') || entry === 'subagents') continue;
        const dir = path.join(PROJECTS_DIR, entry);
        let names;
        try { names = fs.readdirSync(dir); } catch (_) { continue; }
        for (const name of names) {
            if (!name.endsWith('.jsonl')) continue;
            const full = path.join(dir, name);
            let st;
            try { st = fs.statSync(full); } catch (_) { continue; }
            if (st.mtimeMs < cutoff) continue;
            files.push({ full, size: st.size });
        }
    }
    return files;
}

// Tail a single file: read only bytes appended since readOffset, parse whole
// lines, and leave any trailing partial line for the next poll.
function tail(entry, cutoff) {
    let c = _cache.get(entry.full);
    if (!c) { c = { readOffset: 0, records: [] }; _cache.set(entry.full, c); }
    // File shrank (rotated / truncated) → start over.
    if (entry.size < c.readOffset) { c.readOffset = 0; c.records = []; }
    if (entry.size > c.readOffset) {
        let fd = null;
        try {
            fd = fs.openSync(entry.full, 'r');
            const len = entry.size - c.readOffset;
            const buf = Buffer.alloc(len);
            const n = fs.readSync(fd, buf, 0, len, c.readOffset);
            const text = buf.toString('utf8', 0, n);
            const parts = text.split('\n');
            let consumed = c.readOffset;
            // Last part has no trailing newline yet → don't consume it.
            for (let i = 0; i < parts.length - 1; i++) {
                parseInto(parts[i], c.records);
                consumed += Buffer.byteLength(parts[i], 'utf8') + 1;
            }
            c.readOffset = consumed;
        } catch (_) {
            /* transient read error — try again next poll */
        } finally {
            if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
        }
    }
    // Age out old records so memory stays bounded.
    if (c.records.length) c.records = c.records.filter(r => r.ts >= cutoff);
    return c;
}

function tokenBucket() {
    return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 };
}
function addTokens(bucket, r) {
    bucket.input += r.input;
    bucket.output += r.output;
    bucket.cacheCreate += r.cacheCreate;
    bucket.cacheRead += r.cacheRead;
    bucket.total += r.input + r.output + r.cacheCreate + r.cacheRead;
}
function localMidnight(now) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function compute() {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;

    // Refresh every candidate file's tail; drop cache for files that fell out
    // of the window so we don't leak Map entries forever.
    const seenFiles = new Set();
    for (const f of candidateFiles(cutoff)) { tail(f, cutoff); seenFiles.add(f.full); }
    for (const key of _cache.keys()) if (!seenFiles.has(key)) _cache.delete(key);

    // Union all records, dedupe across transcripts, sort ascending.
    const seen = new Set();
    const all = [];
    for (const c of _cache.values()) {
        for (const r of c.records) {
            if (r.ts < cutoff) continue;
            if (r.key && r.key !== ':') {
                if (seen.has(r.key)) continue;
                seen.add(r.key);
            }
            all.push(r);
        }
    }
    all.sort((a, b) => a.ts - b.ts);

    // Group into 5-hour blocks: a new block starts on a >5h idle gap, or once
    // 5h have elapsed since the block's (hour-floored) start.
    const blocks = [];
    let cur = null;
    for (const r of all) {
        const startNew = !cur || (r.ts - cur.lastTs) >= BLOCK_MS || (r.ts - cur.start) >= BLOCK_MS;
        if (startNew) {
            cur = { start: r.ts - (r.ts % 3600000), lastTs: r.ts, records: [] };
            blocks.push(cur);
        }
        cur.records.push(r);
        cur.lastTs = r.ts;
    }

    const midnight = localMidnight(now);
    const today = { tokens: tokenBucket(), cost: 0, requests: 0 };
    const models = new Map();
    const series = new Array(SERIES_MINUTES).fill(0);
    const seriesStart = now - SERIES_MINUTES * 60000;

    for (const r of all) {
        const c = costOf(r);
        if (r.ts >= midnight) {
            addTokens(today.tokens, r);
            today.cost += c;
            today.requests++;
        }
        const tier = tierOf(r.model);
        let mm = models.get(tier);
        if (!mm) { mm = { tier, tokens: tokenBucket(), cost: 0, requests: 0, lastTs: 0 }; models.set(tier, mm); }
        addTokens(mm.tokens, r);
        mm.cost += c;
        mm.requests++;
        if (r.ts > mm.lastTs) mm.lastTs = r.ts;
        if (r.ts >= seriesStart) {
            const idx = Math.min(SERIES_MINUTES - 1, Math.floor((r.ts - seriesStart) / 60000));
            series[idx] += r.input + r.output + r.cacheCreate + r.cacheRead;
        }
    }

    // Active block = the most recent one whose window still covers `now`.
    let block = null;
    const last = blocks[blocks.length - 1];
    if (last && (now - last.start) < BLOCK_MS) {
        const tokens = tokenBucket();
        let cost = 0;
        for (const r of last.records) { addTokens(tokens, r); cost += costOf(r); }
        const endTs = last.start + BLOCK_MS;
        const elapsedMs = Math.max(1, now - last.start);
        const remainingMs = Math.max(0, endTs - now);
        // Burn rate over the last 10 minutes of the block (a "right now" feel),
        // falling back to the block average when the last 10m are empty.
        const recentStart = now - 10 * 60000;
        let recentTok = 0;
        for (const r of last.records) if (r.ts >= recentStart) recentTok += r.input + r.output + r.cacheCreate + r.cacheRead;
        const recentMins = Math.min(10, elapsedMs / 60000);
        const burnRecent = recentMins > 0 ? recentTok / recentMins : 0;
        const burnAvg = tokens.total / (elapsedMs / 60000);
        const burnRatePerMin = burnRecent > 0 ? burnRecent : burnAvg;
        const projectedTokens = Math.round(tokens.total + burnAvg * (remainingMs / 60000));
        block = {
            active: true,
            startTs: last.start,
            endTs,
            elapsedMs,
            remainingMs,
            pct: Math.min(100, (elapsedMs / BLOCK_MS) * 100),
            tokens,
            cost,
            requests: last.records.length,
            burnRatePerMin: Math.round(burnRatePerMin),
            projectedTokens,
            projectedCost: cost + (burnAvg * (remainingMs / 60000)) * (cost / Math.max(1, tokens.total)),
            lastTs: last.lastTs,
        };
    } else {
        block = { active: false, remainingMs: 0, tokens: tokenBucket(), cost: 0, requests: 0, burnRatePerMin: 0 };
    }

    const modelList = [...models.values()]
        .map(m => ({ tier: m.tier, tokens: m.tokens.total, cost: m.cost, requests: m.requests, lastTs: m.lastTs }))
        .sort((a, b) => b.tokens - a.tokens);

    return {
        now,
        block,
        today,
        models: modelList,
        series,
        seriesMinutes: SERIES_MINUTES,
        hasData: all.length > 0,
        updatedAt: now,
    };
}

// Public snapshot with a short throttle so rapid polls are cheap.
function snapshot() {
    const now = Date.now();
    if (_lastComputed && (now - _lastAt) < MIN_RECOMPUTE_MS) return _lastComputed;
    _lastComputed = compute();
    _lastAt = now;
    return _lastComputed;
}

function mount(app, requireAuthed) {
    app.get('/api/claude-usage', requireAuthed, (req, res) => {
        try { res.json({ ok: true, data: snapshot() }); }
        catch (e) { res.status(500).json({ ok: false, error: String(e && e.message || e) }); }
    });
}

module.exports = { mount, snapshot, tierOf, priceOf };
