/**
 * Real-time Claude usage, computed from the local Claude Code transcripts.
 *
 * Claude Code appends every turn to ~/.claude/projects/<enc-cwd>/<id>.jsonl,
 * and each session's subagents (Task tool, workflows) to
 * <enc-cwd>/<session-id>/subagents/**\/agent-*.jsonl. Each assistant line
 * carries a `message.usage` block (input/output/cache tokens with a 5m/1h
 * cache-write split), a `model`, a `timestamp`, a `requestId`, and the parent
 * `sessionId` — subagent lines carry the parent's id, so usage folds cleanly
 * into per-session totals. We tail every file incrementally (only the bytes
 * appended since the last poll) so a widget can poll every few seconds without
 * ever re-reading a day of history.
 *
 * From the deduped stream we derive:
 *   - the active 5-hour rolling window (Claude's usage-limit block) with the
 *     time left until it resets,
 *   - today's totals (since local midnight),
 *   - a live burn rate + linear projection to the end of the block,
 *   - a per-model breakdown,
 *   - a per-SESSION breakdown (block + today) — which session is burning most,
 *   - a per-minute token series for a sparkline.
 *
 * Cost is an ESTIMATE from Anthropic's public list prices — a Max/Pro seat
 * doesn't pay per token, but dollars are the most legible cross-model unit for
 * "how hard am I leaning on the model right now". Rates are per-operation
 * (input / output / cache read / 5m cache write / 1h cache write) and match
 * platform.claude.com/docs/en/about-claude/pricing as of 2026-07: this is the
 * same math Claude Code's own /usage screen does, including the fast-mode
 * premium (usage.speed === "fast") and the us-residency multiplier.
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
// How many sessions the breakdown ships to the client.
const MAX_SESSIONS = 12;

// USD per MTok by rate family (list prices, 2026-07). `cr` = cache read,
// `cw5m`/`cw1h` = 5-minute / 1-hour cache writes (1.25x / 2x base input).
const RATES = {
    fable:      { in: 10,   out: 50, cr: 1.0,  cw5m: 12.5,  cw1h: 20 },
    opus:       { in: 5,    out: 25, cr: 0.5,  cw5m: 6.25,  cw1h: 10 },
    opusLegacy: { in: 15,   out: 75, cr: 1.5,  cw5m: 18.75, cw1h: 30 },
    sonnet5i:   { in: 2,    out: 10, cr: 0.2,  cw5m: 2.5,   cw1h: 4 },
    sonnet:     { in: 3,    out: 15, cr: 0.3,  cw5m: 3.75,  cw1h: 6 },
    haiku:      { in: 1,    out: 5,  cr: 0.1,  cw5m: 1.25,  cw1h: 2 },
    haikuLegacy:{ in: 0.8,  out: 4,  cr: 0.08, cw5m: 1.0,   cw1h: 1.6 },
};
// Fast mode (research preview) reprices input/output; cache multipliers stack
// on the fast input price.
const FAST_RATES = {
    'opus-4-8': { in: 10, out: 50 },
    'opus-4-7': { in: 30, out: 150 },
};
// Sonnet 5 introductory pricing ends 2026-08-31 (see docs pricing page).
const SONNET5_STD_TS = Date.parse('2026-09-01T00:00:00Z');

function tierOf(model) {
    const m = (model || '').toLowerCase();
    if (m.includes('opus')) return 'opus';
    if (m.includes('sonnet')) return 'sonnet';
    if (m.includes('haiku')) return 'haiku';
    if (m.includes('fable') || m.includes('mythos')) return 'fable';
    return 'other';
}

function rateOf(model, ts) {
    const m = (model || '').toLowerCase();
    if (m.includes('fable') || m.includes('mythos')) return RATES.fable;
    if (m.includes('opus')) {
        // Opus 4.5+ dropped to $5/$25; 4.1 and earlier keep legacy pricing.
        return /opus-4-([5-9]|\d{2})|opus-[5-9]/.test(m) ? RATES.opus : RATES.opusLegacy;
    }
    if (m.includes('sonnet')) {
        if (/sonnet-5/.test(m) && ts < SONNET5_STD_TS) return RATES.sonnet5i;
        return RATES.sonnet;
    }
    if (m.includes('haiku')) {
        return /haiku-([4-9]|\d{2})/.test(m) ? RATES.haiku : RATES.haikuLegacy;
    }
    return RATES.sonnet;
}
// Back-compat shim (older callers/tests used priceOf(model).in etc.).
function priceOf(model) { return rateOf(model, Date.now()); }

const M = 1e6;
function costOf(r) {
    const p = rateOf(r.model, r.ts);
    let inRate = p.in, outRate = p.out, cacheScale = 1;
    if (r.fast) {
        const f = FAST_RATES[Object.keys(FAST_RATES).find(k => r.model.includes(k))];
        if (f) { inRate = f.in; outRate = f.out; cacheScale = f.in / p.in; }
    }
    let usd = (r.input * inRate
        + r.output * outRate
        + r.cw5m * p.cw5m * cacheScale
        + r.cw1h * p.cw1h * cacheScale
        + r.cacheRead * p.cr * cacheScale) / M;
    if (r.geoUs) usd *= 1.1;
    // Server-side web search bills $10 per 1k requests on top of tokens.
    usd += (r.webSearch || 0) * 0.01;
    return usd;
}

// Per-file tail cache:
//   { readOffset, records: [{ts,model,key,input,output,cw5m,cw1h,cacheRead,fast,geoUs}],
//     meta: {sess, slug, cwd, side} }
// readOffset is always parked on a newline boundary so the next read starts on
// a clean line even mid-append. meta identifies which SESSION the file belongs
// to (subagent files carry the parent session's id) for the session breakdown.
const _cache = new Map();
let _lastComputed = null;
let _lastAt = 0;

function parseInto(line, c) {
    if (!line) return;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { return; }
    if (!obj) return;
    // Session identity can appear on any line type; keep the freshest bits.
    if (obj.sessionId && !c.meta.sess) c.meta.sess = obj.sessionId;
    if (obj.slug && !c.meta.slug) c.meta.slug = obj.slug;
    if (obj.cwd && !c.meta.cwd) c.meta.cwd = obj.cwd;
    // File-level sidechain flag = "this file IS a subagent transcript", decided
    // by the first line (agent files open with a sidechain line). Main
    // transcripts also carry per-line sidechains (in-session Task agents) —
    // those are flagged per record below, not on the file.
    if (!c.meta.sideKnown) { c.meta.side = obj.isSidechain === true; c.meta.sideKnown = true; }
    if (obj.type !== 'assistant') return;
    const msg = obj.message;
    if (!msg || !msg.usage) return;
    const u = msg.usage;
    const ts = Date.parse(obj.timestamp || msg.timestamp || '');
    if (!ts) return;
    // 5m vs 1h cache writes are priced differently (1.25x vs 2x input); the
    // usage block breaks them out. Without the breakdown, assume 5m (the API
    // default) so we never over-charge.
    const cc = u.cache_creation_input_tokens || 0;
    const b = u.cache_creation || null;
    const cw1h = b ? (b.ephemeral_1h_input_tokens || 0) : 0;
    const cw5m = b ? (b.ephemeral_5m_input_tokens || 0) : cc;
    c.records.push({
        ts,
        model: (msg.model || '').toLowerCase(),
        // Dedupe key across transcripts that replay the same history on resume.
        key: (msg.id || '') + ':' + (obj.requestId || ''),
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cw5m,
        cw1h,
        cacheRead: u.cache_read_input_tokens || 0,
        fast: u.speed === 'fast',
        geoUs: u.inference_geo === 'us',
        side: obj.isSidechain === true,
        webSearch: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0,
    });
}

// List *.jsonl files touched within the retention window — recursively, so
// subagent/workflow transcripts under <enc-cwd>/<session-id>/subagents/** are
// counted too (they are real usage: rate limits and /usage both include them;
// skipping them undercounted heavy Task/workflow turns by 25-40%). Workflow
// journals hold no usage — skip them by name to save the read.
function candidateFiles(cutoff) {
    const files = [];
    const walk = (dir, depth) => {
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of ents) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (depth < 7 && e.name !== 'memory') walk(full, depth + 1);
                continue;
            }
            if (!e.name.endsWith('.jsonl') || e.name === 'journal.jsonl') continue;
            let st;
            try { st = fs.statSync(full); } catch (_) { continue; }
            if (st.mtimeMs < cutoff) continue;
            files.push({ full, size: st.size });
        }
    };
    walk(PROJECTS_DIR, 0);
    return files;
}

// Tail a single file: read only bytes appended since readOffset, parse whole
// lines, and leave any trailing partial line for the next poll.
function tail(entry, cutoff) {
    let c = _cache.get(entry.full);
    if (!c) { c = { readOffset: 0, records: [], meta: { sess: '', slug: '', cwd: '', side: false, sideKnown: false } }; _cache.set(entry.full, c); }
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
                parseInto(parts[i], c);
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
    const cc = r.cw5m + r.cw1h;
    bucket.input += r.input;
    bucket.output += r.output;
    bucket.cacheCreate += cc;
    bucket.cacheRead += r.cacheRead;
    bucket.total += r.input + r.output + cc + r.cacheRead;
}
function tokensOf(r) { return r.input + r.output + r.cw5m + r.cw1h + r.cacheRead; }
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

    // Union all records (keeping their file's session meta), dedupe across
    // transcripts, sort ascending.
    const seen = new Set();
    const all = [];
    for (const c of _cache.values()) {
        for (const r of c.records) {
            if (r.ts < cutoff) continue;
            if (r.key && r.key !== ':') {
                if (seen.has(r.key)) continue;
                seen.add(r.key);
            }
            all.push({ r, meta: c.meta });
        }
    }
    all.sort((a, b) => a.r.ts - b.r.ts);

    // Group into 5-hour blocks: a new block starts on a >5h idle gap, or once
    // 5h have elapsed since the block's (hour-floored) start.
    const blocks = [];
    let cur = null;
    for (const { r } of all) {
        const startNew = !cur || (r.ts - cur.lastTs) >= BLOCK_MS || (r.ts - cur.start) >= BLOCK_MS;
        if (startNew) {
            cur = { start: r.ts - (r.ts % 3600000), lastTs: r.ts, records: [] };
            blocks.push(cur);
        }
        cur.records.push(r);
        cur.lastTs = r.ts;
    }
    const last = blocks[blocks.length - 1];
    const blockActive = !!(last && (now - last.start) < BLOCK_MS);
    const blockStart = blockActive ? last.start : Infinity;

    const midnight = localMidnight(now);
    const today = { tokens: tokenBucket(), cost: 0, requests: 0 };
    const models = new Map();
    const sessions = new Map();
    const series = new Array(SERIES_MINUTES).fill(0);
    const seriesStart = now - SERIES_MINUTES * 60000;

    for (const { r, meta } of all) {
        const c = costOf(r);
        const inToday = r.ts >= midnight;
        const inBlock = r.ts >= blockStart;
        if (inToday) {
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
            series[idx] += tokensOf(r);
        }
        // Per-session fold: subagent files carry the parent session's id, so a
        // Task-heavy session shows its whole bill under one row.
        if (inToday || inBlock) {
            const sid = meta.sess || 'unknown';
            let ss = sessions.get(sid);
            if (!ss) {
                ss = {
                    id: sid, slug: '', cwd: '', lastTs: 0,
                    block: { tok: 0, cost: 0, req: 0, subCost: 0 },
                    today: { tok: 0, cost: 0, req: 0, subCost: 0 },
                };
                sessions.set(sid, ss);
            }
            // Label from the main transcript, not a subagent's (worktree cwds).
            if (!meta.side || !ss.cwd) {
                if (meta.slug && (!ss.slug || !meta.side)) ss.slug = meta.slug;
                if (meta.cwd && (!ss.cwd || !meta.side)) ss.cwd = meta.cwd;
            }
            if (r.ts > ss.lastTs) ss.lastTs = r.ts;
            const tok = tokensOf(r);
            for (const [on, scope] of [[inBlock, ss.block], [inToday, ss.today]]) {
                if (!on) continue;
                scope.tok += tok;
                scope.cost += c;
                scope.req++;
                if (meta.side || r.side) scope.subCost += c;
            }
        }
    }

    // Active block = the most recent one whose window still covers `now`.
    let block = null;
    if (blockActive) {
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
        for (const r of last.records) if (r.ts >= recentStart) recentTok += tokensOf(r);
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

    // Session breakdown, most expensive first in the scope that matters now.
    const sessionList = [...sessions.values()]
        .filter(s => s.block.tok > 0 || s.today.tok > 0)
        .map(s => ({
            id: s.id,
            shortId: s.id.slice(0, 8),
            project: s.cwd ? path.basename(s.cwd) : '',
            slug: s.slug,
            cwd: s.cwd,
            lastTs: s.lastTs,
            block: s.block,
            today: s.today,
        }))
        .sort((a, b) => (blockActive ? b.block.cost - a.block.cost : b.today.cost - a.today.cost))
        .slice(0, MAX_SESSIONS);

    return {
        now,
        block,
        today,
        models: modelList,
        sessions: sessionList,
        sessionScope: blockActive ? 'block' : 'today',
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

module.exports = { mount, snapshot, tierOf, priceOf, rateOf, costOf };
