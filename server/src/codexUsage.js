/**
 * Real-time codex usage, computed from the local codex rollout transcripts.
 *
 * codex appends every session to ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
 * as newline-delimited records, each one opening with its own timestamp:
 *
 *   {"timestamp":"…","ordinal":N,"type":"…","payload":{…}}
 *
 * Three of those types carry everything this file needs:
 *
 *   session_meta        line 1 — session_id, cwd, model, cli_version
 *   token_usage_record  per response — `usage` (the delta) AND
 *                       `thread_token_usage` (the running total for the thread)
 *   event_msg/token_count
 *                       per response — `info.total_token_usage`,
 *                       `info.model_context_window`, and `rate_limits`
 *
 * `rate_limits` is the part Claude's transcripts have no equivalent for: the
 * API reports the account's real limit windows back to the client —
 * `used_percent`, `window_minutes` and `resets_at` — so the gauges here are
 * measured rather than estimated. Claude's side has to approximate a weekly
 * ceiling from a calibration point (see WEEK_LIMIT_USD in widgets.js); codex
 * simply says.
 *
 * WHAT MAKES THIS DIFFERENT FROM claudeUsage.js: size. Claude's transcripts are
 * a few MB; codex writes its full reasoning and every tool result into the same
 * file, and on this install seven days of them is **1.4 GB** across 19 files,
 * one of them 115 MB. Reading that the way claudeUsage tails its projects dir
 * would stall the daemon on every cold start, so nothing here ever reads a
 * whole file:
 *
 *   - Records are cumulative and timestamps are monotonic, so "tokens since T"
 *     is one subtraction between two records — found by BINARY SEARCH over byte
 *     offsets (~17 probes of 8 KB), not by summing a day of history. That is
 *     how TODAY stays exact on a file we have never read.
 *   - The per-record stream (burn rate, sparkline) only ever needs the recent
 *     end, so a new file is picked up at `size - INITIAL_TAIL` and followed
 *     forward from there. A dormant session gets a smaller window than a live
 *     one, because all we want from it is its total and the limits.
 *   - The first 64 KB is always read, because session_meta is line 1 and it is
 *     the only place the cwd and model are written.
 *
 * Steady state is then just the bytes appended since the last poll.
 *
 * No cost estimate. claudeUsage prices tokens from Anthropic's published list,
 * and there is no equivalent public rate for the model codex is running here —
 * inventing one to fill the same-shaped column would make the number worse than
 * absent. codex reports percentages against its real limits, which is the thing
 * the dollars were a proxy for anyway.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// Read lazily, not captured at require time: a test points this at a fixture,
// and an install that keeps codex somewhere other than ~/.codex can say so.
function sessionsDir() {
    const root = process.env.SOA_CODEX_HOME || path.join(os.homedir(), '.codex');
    return path.join(root, 'sessions');
}

// Retention for the per-record stream + the file scan window.
const WINDOW_MS = 7 * 24 * 3600 * 1000;
// A session that has written in this long is "live": worth a real tail so the
// burn rate and sparkline have something to work with.
const LIVE_MS = 15 * 60 * 1000;
// How far back a first sighting reaches. A record lands roughly every 130 KB in
// a busy session, so 4 MB is ~30 records; the dormant window only has to be
// deep enough to contain one token_count for the totals and the limits.
const INITIAL_TAIL_LIVE = 4 << 20;    // 4 MB
const INITIAL_TAIL_COLD = 512 << 10;  // 512 KB
// session_meta is the first line; this is only ever a bound on a malformed one.
const HEAD_BYTES = 64 << 10;
// Binary-search probe size. One probe should contain a whole line boundary.
// codex records average ~15 KB but a single tool result can be HUNDREDS of KB
// — one file here averages 570 KB a line — so the probe is sized for those,
// and a probe that still finds no boundary costs another probe rather than a
// wrong answer (see seekTs).
const PROBE_BYTES = 1 << 20;
// Give up walking forward for a cumulative record after this much; a file whose
// records are further apart than this contributes its tail total only.
const SCAN_LIMIT = 4 << 20;
// Read stride. A record longer than this is stepped over rather than parsed,
// which is safe precisely because the records that matter are the small ones:
// a token_usage_record is ~900 bytes. What gets skipped is a giant tool result,
// and the parser resynchronises on the next newline by itself.
const CHUNK_BYTES = 4 << 20;
// How far the linear half of seekTs will walk. Generous because it runs once
// per file per day, and because the alternative to walking is being wrong.
const SEEK_SCAN_LIMIT = 64 << 20;
const MIN_RECOMPUTE_MS = 1200;
const SERIES_MINUTES = 30;
const MAX_SESSIONS = 12;
// Per-record retention for burn/sparkline. Anything older is dropped.
const RECENT_MS = 65 * 60 * 1000;

const _cache = new Map();   // file path -> tail state
let _lastComputed = null;
let _lastAt = 0;

// ── line helpers ────────────────────────────────────────────────────────
// Every record opens with its own timestamp, so the cheap reads below never
// need JSON.parse — which matters when the alternative is parsing a 15 KB
// reasoning blob to learn when it was written.
const TS_RE = /^\{"timestamp":"([^"]+)"/;
function lineTs(line) {
    const m = TS_RE.exec(line);
    if (!m) return 0;
    const t = Date.parse(m[1]);
    return Number.isFinite(t) ? t : 0;
}

function tokenBucket() {
    return { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
}
function addUsage(bucket, u) {
    if (!u) return;
    bucket.input += u.input_tokens || 0;
    bucket.cached += u.cached_input_tokens || 0;
    bucket.cacheWrite += u.cache_write_input_tokens || 0;
    bucket.output += u.output_tokens || 0;
    bucket.reasoning += u.reasoning_output_tokens || 0;
    bucket.total += u.total_tokens || 0;
}
function bucketFrom(u) {
    const b = tokenBucket();
    addUsage(b, u);
    return b;
}
function subBuckets(a, b) {
    const out = tokenBucket();
    for (const k of Object.keys(out)) out[k] = Math.max(0, (a[k] || 0) - (b[k] || 0));
    return out;
}

function localMidnight(now) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

// ── file discovery ──────────────────────────────────────────────────────
// sessions/YYYY/MM/DD/rollout-*.jsonl. The date directories bound the walk, so
// a long-lived install does not re-stat years of history every poll.
function candidateFiles(cutoff) {
    const files = [];
    const walk = (dir, depth) => {
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of ents) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { if (depth < 4) walk(full, depth + 1); continue; }
            if (!e.name.endsWith('.jsonl')) continue;
            let st;
            try { st = fs.statSync(full); } catch (_) { continue; }
            if (st.mtimeMs < cutoff) continue;
            files.push({ full, size: st.size, mtimeMs: st.mtimeMs });
        }
    };
    walk(sessionsDir(), 0);
    return files;
}

// ── byte-exact scanning ─────────────────────────────────────────────────
//
// Everything below works on Buffers and only decodes COMPLETE lines. The first
// version decoded each chunk to a string and carried the trailing partial line
// forward, which is the usual shape — and wrong here, because a chunk boundary
// can land inside a multi-byte character. toString() turns the truncated half
// into a replacement character, and from then on every offset computed from
// that text is off by a byte or two. On a file where those offsets decide which
// side of midnight a record falls, that is not a rounding error. Newlines are
// ASCII, so finding them in the raw bytes is both exact and faster.
function readBuf(fd, from, len) {
    if (len <= 0) return Buffer.alloc(0);
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, from);
    return n === len ? buf : buf.subarray(0, n);
}

const NL = 0x0A;

/**
 * Call `fn(line, offset)` for every complete line in [from, to), and return the
 * offset just past the last one consumed. Stops early when `fn` returns a
 * value, handing it back through `out`.
 */
function eachLine(fd, from, to, limit, fn) {
    let at = from;
    while (at < to && (at - from) < limit) {
        const buf = readBuf(fd, at, Math.min(CHUNK_BYTES, to - at));
        if (!buf.length) break;
        const lastNl = buf.lastIndexOf(NL);
        if (lastNl < 0) {
            // A record longer than a whole chunk. Step over it: what gets
            // skipped is a giant tool result, never a usage record, and the
            // next chunk resynchronises on its own newline.
            at += buf.length;
            continue;
        }
        let start = 0;
        while (start <= lastNl) {
            const nl = buf.indexOf(NL, start);
            const stop = fn(buf.toString('utf8', start, nl), at + start);
            if (stop !== undefined) return { consumed: at + start, stop };
            start = nl + 1;
        }
        at += lastNl + 1;
    }
    return { consumed: Math.min(at, to), stop: undefined };
}

/** Offset of the first byte after the next newline at or after `from`. */
function nextLineStart(fd, size, from) {
    let at = from;
    while (at < size) {
        const buf = readBuf(fd, at, Math.min(PROBE_BYTES, size - at));
        if (!buf.length) break;
        const nl = buf.indexOf(NL);
        if (nl >= 0) return at + nl + 1;
        at += buf.length;
    }
    return size;
}

/** Timestamp of the record starting at `off`. */
function firstTsAt(fd, size, off) {
    const buf = readBuf(fd, off, Math.min(PROBE_BYTES, size - off));
    const nl = buf.indexOf(NL);
    return lineTs(buf.toString('utf8', 0, nl < 0 ? buf.length : nl));
}

/**
 * Offset of the first record whose timestamp is at or after `target`.
 *
 * Timestamps are monotonic and every line carries its own, so this is an
 * ordinary binary search over the file. Two wrinkles:
 *
 *   - an offset lands mid-line, so each probe resyncs forward to the next
 *     newline before reading a timestamp, and a probe that finds no boundary
 *     at all says NOTHING about which side of the target it is on — advancing
 *     on that non-answer is what used to walk the search straight past the
 *     record it was looking for;
 *   - halving stops while the range is still up to one probe wide, and the
 *     rest is scanned linearly. Returning the last probe's guess instead is
 *     off by however much of the range was left — enough to put a midnight
 *     baseline on the wrong side of the first request of the day, and hand
 *     most of that day to yesterday.
 */
function seekTs(fd, size, target) {
    let lo = 0, hi = size;
    for (let i = 0; i < 60 && (hi - lo) > PROBE_BYTES; i++) {
        const mid = (lo + hi) >> 1;
        const lineStart = nextLineStart(fd, hi, mid);
        if (lineStart >= hi) break;              // the range is one huge record
        const ts = firstTsAt(fd, size, lineStart);
        if (!ts) break;
        if (ts >= target) hi = lineStart; else lo = lineStart;
    }
    return scanForTs(fd, size, Math.min(lo, hi), target);
}

/** Linear half of seekTs: `from` must already be a line boundary. */
function scanForTs(fd, size, from, target) {
    const r = eachLine(fd, from, size, SEEK_SCAN_LIMIT, (line, off) => {
        const ts = lineTs(line);
        if (ts && ts >= target) return off;
        return undefined;
    });
    return r.stop !== undefined ? r.stop : Math.min(r.consumed, size);
}

/**
 * The first cumulative reading of EACH series at or after `from`, with that
 * reading's own delta alongside it.
 *
 * Two series, and they do not agree. codex writes a running total twice — as
 * `thread_token_usage` on every token_usage_record, and as
 * `info.total_token_usage` on every token_count — and measured over one real
 * transcript they diverge on 399 of 448 readings, the record series running
 * a couple of percent ahead. They are different accountings, so a subtraction
 * that takes its minuend from one and its subtrahend from the other produces
 * a number belonging to neither. (It showed up as a day whose cached input
 * exceeded its own total, which is impossible within either series.) Each is
 * therefore carried separately and only ever subtracted from itself.
 *
 * The delta matters for the same reason: a cumulative reading INCLUDES the
 * record it is attached to, so using it directly as a midnight baseline gives
 * the first request of the day away to yesterday.
 */
function cumulativeAfter(fd, size, from) {
    const out = { rec: null, info: null };
    eachLine(fd, from, size, SCAN_LIMIT, (line) => {
        const isRec = !out.rec && line.indexOf('"token_usage_record"') >= 0;
        const isCnt = !out.info && line.indexOf('"token_count"') >= 0;
        if (isRec || isCnt) {
            try {
                const p = JSON.parse(line).payload;
                if (p && isRec && p.thread_token_usage) {
                    out.rec = {
                        ts: lineTs(line),
                        tokens: bucketFrom(p.thread_token_usage),
                        delta: p.usage ? bucketFrom(p.usage) : tokenBucket(),
                    };
                } else if (p && isCnt && p.type === 'token_count' && p.info && p.info.total_token_usage) {
                    out.info = {
                        ts: lineTs(line),
                        tokens: bucketFrom(p.info.total_token_usage),
                        delta: p.info.last_token_usage ? bucketFrom(p.info.last_token_usage) : tokenBucket(),
                    };
                }
            } catch (_) { /* a record we could not read is one we skip */ }
        }
        return (out.rec && out.info) ? true : undefined;
    });
    return out;
}

// ── parsing ─────────────────────────────────────────────────────────────
// Only three record types matter, and the substring guards below keep the JSON
// parser away from the reasoning and tool-output records that are most of the
// bytes in a rollout.
function parseInto(line, c) {
    if (!line || line.charCodeAt(0) !== 123 /* { */) return;
    const isUsage = line.indexOf('"token_usage_record"') >= 0;
    const isCount = !isUsage && line.indexOf('"token_count"') >= 0;
    const isMeta = !isUsage && !isCount && line.indexOf('"session_meta"') >= 0;
    const isTurn = !isUsage && !isCount && !isMeta && line.indexOf('"turn_context"') >= 0;
    if (!isUsage && !isCount && !isMeta && !isTurn) return;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { return; }
    const p = obj && obj.payload;
    if (!p) return;
    const ts = Date.parse(obj.timestamp || '') || 0;

    if (isMeta) {
        c.meta.id = p.session_id || p.id || c.meta.id;
        c.meta.cwd = p.cwd || c.meta.cwd;
        c.meta.cli = p.cli_version || c.meta.cli;
        c.meta.startTs = ts || c.meta.startTs;
        // The model is not a top-level field; it is stamped into the
        // provenance of the instructions the session was opened with.
        const prov = p.base_instructions && p.base_instructions.provenance;
        const m = p.model || (prov && prov.model);
        if (m) c.meta.model = m;
        return;
    }
    if (isTurn) {
        // ONLY a root turn names the session's model. codex runs its own
        // sub-turns through the same record — an automatic code review reports
        // `codex-auto-review` — and letting those through renamed a whole
        // session after whatever it happened to do last.
        if (p.model && p.turn_id && p.turn_id === p.root_turn_id) c.meta.model = p.model;
        if (p.cwd && !c.meta.cwd) c.meta.cwd = p.cwd;
        return;
    }
    if (isCount) {
        if (p.type !== 'token_count') return;
        const info = p.info || {};
        if (info.model_context_window) c.meta.contextWindow = info.model_context_window;
        if (info.total_token_usage) c.cumInfo = { ts, tokens: bucketFrom(info.total_token_usage) };
        if (p.rate_limits) c.limits = { ts, raw: p.rate_limits };
        return;
    }
    // token_usage_record: the per-response delta plus the running thread total.
    if (p.thread_token_usage) c.cumRec = { ts, tokens: bucketFrom(p.thread_token_usage) };
    if (p.thread_id && !c.meta.id) c.meta.id = p.thread_id;
    if (p.usage && ts) {
        c.records.push({ ts, u: p.usage });
        c.requests++;
    }
}

/**
 * Parse [from, to) into `c` and return the offset of the last byte consumed.
 *
 * A trailing partial line is never consumed, so it is re-read on the next poll
 * and parsed exactly once — the same contract claudeUsage.tail() uses, and the
 * reason a record split across two polls can be neither double counted nor
 * lost.
 */
function chunkedParse(fd, from, to, c) {
    return eachLine(fd, from, to, Infinity, (line) => { parseInto(line, c); }).consumed;
}

/**
 * Bring one file's state up to date, reading only what is new.
 *
 * First sighting: the head (for session_meta), then a bounded tail sized by
 * whether the session is still writing. Every sighting after that: the bytes
 * appended since last time, which is what makes a 2.5s poll affordable against
 * a gigabyte of transcripts.
 */
function tail(entry, now) {
    let c = _cache.get(entry.full);
    const fresh = !c;
    if (!c) {
        c = {
            readOffset: 0, records: [], requests: 0, cumRec: null, cumInfo: null, limits: null,
            meta: { id: '', cwd: '', model: '', cli: '', startTs: 0, contextWindow: 0 },
            dayKey: '', dayBase: null, partial: false,
        };
        _cache.set(entry.full, c);
    }
    if (entry.size < c.readOffset) { c.readOffset = 0; c.records = []; }

    let fd = null;
    try {
        fd = fs.openSync(entry.full, 'r');
        if (fresh) {
            // session_meta is line 1 and is the only record carrying the cwd.
            // Parsed into a throwaway whose `meta` IS c.meta, so the identity
            // lands without the head's records joining the recent stream.
            chunkedParse(fd, 0, Math.min(HEAD_BYTES, entry.size),
                { meta: c.meta, records: [], requests: 0, cumRec: null, cumInfo: null, limits: null });
            const live = (now - entry.mtimeMs) < LIVE_MS;
            const want = live ? INITIAL_TAIL_LIVE : INITIAL_TAIL_COLD;
            let start = Math.max(0, entry.size - want);
            if (start > 0) {
                // Resync forward to a line boundary; a partial first line would
                // parse as nothing at best and as the wrong record at worst.
                // This walks rather than taking one probe, because a single
                // record here can be larger than any probe worth reading — and
                // the first version gave up and skipped the whole tail when it
                // landed inside one, which silently cost the newest session its
                // entire day.
                start = nextLineStart(fd, entry.size, start);
                c.partial = true;
            }
            c.readOffset = start;
        }
        if (entry.size > c.readOffset) {
            c.readOffset = Math.max(c.readOffset, chunkedParse(fd, c.readOffset, entry.size, c));
        }
        // Today's baseline: one subtraction instead of a day of summing. Cached
        // per calendar day, and skipped entirely when the session started after
        // midnight — then the whole thread IS today.
        const midnight = localMidnight(now);
        const dayKey = String(midnight);
        if (c.dayKey !== dayKey) {
            c.dayKey = dayKey;
            // Three cases, and only the last one costs a search. A session that
            // began after midnight IS today in full; one that has not been
            // written to since midnight contributes nothing to today; only a
            // session that straddles the boundary has to be looked up.
            const zero = { rec: tokenBucket(), info: tokenBucket() };
            if (c.meta.startTs && c.meta.startTs >= midnight) c.dayBase = zero;
            else if (entry.mtimeMs < midnight) {
                // Nothing of this thread is today: the baseline IS the total.
                c.dayBase = { rec: c.cumRec && c.cumRec.tokens, info: c.cumInfo && c.cumInfo.tokens };
            } else {
                const off = seekTs(fd, entry.size, midnight);
                const found = cumulativeAfter(fd, entry.size, off);
                // The baseline is each series as it stood the instant BEFORE
                // the first reading of the day — that reading minus its own
                // delta. A series with no reading after midnight contributed
                // nothing today, so its baseline is its own total.
                c.dayBase = {
                    rec: found.rec ? subBuckets(found.rec.tokens, found.rec.delta)
                        : (c.cumRec && c.cumRec.tokens),
                    info: found.info ? subBuckets(found.info.tokens, found.info.delta)
                        : (c.cumInfo && c.cumInfo.tokens),
                };
            }
        }
    } catch (_) {
        /* transient read error — try again next poll */
    } finally {
        if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
    }

    const recentCut = now - RECENT_MS;
    if (c.records.length) c.records = c.records.filter(r => r.ts >= recentCut);
    return c;
}

// ── limits ──────────────────────────────────────────────────────────────
// The API reports these against the ACCOUNT, not the session, so every live
// transcript carries the same numbers and the freshest one wins.
function normalizeLimit(l) {
    if (!l || typeof l.used_percent !== 'number') return null;
    const windowMinutes = l.window_minutes || 0;
    const resetsAt = l.resets_at ? l.resets_at * 1000 : 0;
    return {
        usedPercent: Math.max(0, Math.min(100, l.used_percent)),
        windowMinutes,
        label: windowLabel(windowMinutes),
        resetsAt,
        remainingMs: resetsAt ? Math.max(0, resetsAt - Date.now()) : 0,
    };
}
function windowLabel(min) {
    if (!min) return 'LIMIT';
    if (min % 10080 === 0) return (min / 10080 === 1 ? 'WEEKLY' : `${min / 10080}-WEEK`);
    if (min % 1440 === 0) return (min / 1440 === 1 ? 'DAILY' : `${min / 1440}D WINDOW`);
    if (min % 60 === 0) return `${min / 60}H WINDOW`;
    return `${min}M WINDOW`;
}

function compute() {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;

    const seen = new Set();
    let anyFiles = false;
    for (const f of candidateFiles(cutoff)) { anyFiles = true; tail(f, now); seen.add(f.full); }
    for (const key of _cache.keys()) if (!seen.has(key)) _cache.delete(key);

    // `requestsSeen` is NOT today's request count and must never be shown as
    // one. The token figures come from cumulative counters, so they are exact
    // however little of a file we read; a request COUNT can only come from
    // counting records, and we deliberately do not read a day of them. Naming
    // it for what it is stops the widget from putting an honest number and a
    // partial one side by side.
    const today = { tokens: tokenBucket(), requestsSeen: 0 };
    const total = tokenBucket();
    const series = new Array(SERIES_MINUTES).fill(0);
    const seriesStart = now - SERIES_MINUTES * 60000;
    const models = new Map();
    const threads = new Map();
    let limits = null, limitsTs = 0, planType = '', credits = null;
    let partial = false;
    let lastTs = 0;

    for (const c of _cache.values()) {
        if (c.partial) partial = true;
        if (c.limits && c.limits.ts > limitsTs) {
            limitsTs = c.limits.ts;
            const raw = c.limits.raw;
            limits = {
                primary: normalizeLimit(raw.primary),
                secondary: normalizeLimit(raw.secondary),
            };
            planType = raw.plan_type || '';
            credits = raw.credits || null;
        }
        // One thread can span more than one rollout file when it is resumed.
        // The cumulative counter belongs to the THREAD, so the largest wins
        // rather than the sum — adding them would double-count the history the
        // resumed file replays.
        const id = c.meta.id || '(unknown)';
        let th = threads.get(id);
        if (!th) {
            th = {
                id, cwd: c.meta.cwd, model: c.meta.model, contextWindow: c.meta.contextWindow,
                total: tokenBucket(), today: tokenBucket(), requests: 0, lastTs: 0, ctxTokens: 0,
            };
            threads.set(id, th);
        }
        if (c.meta.cwd && !th.cwd) th.cwd = c.meta.cwd;
        if (c.meta.model) th.model = c.meta.model;
        if (c.meta.contextWindow) th.contextWindow = c.meta.contextWindow;
        // Prefer the record series — it is the more complete accounting of the
        // two, and it is the one the sparkline's per-record deltas come from —
        // and fall back to the token_count series only when a file's tail held
        // no usage record at all. Whichever is used, both ends of the
        // subtraction come from it.
        const cum = c.cumRec || c.cumInfo;
        const base = c.cumRec ? (c.dayBase && c.dayBase.rec) : (c.dayBase && c.dayBase.info);
        if (cum) {
            if (cum.tokens.total > th.total.total) th.total = cum.tokens;
            if (cum.ts > th.lastTs) th.lastTs = cum.ts;
            const day = subBuckets(cum.tokens, base || cum.tokens);
            if (day.total > th.today.total) th.today = day;
        }
        th.requests += c.requests;

        let newest = 0;
        for (const r of c.records) {
            if (r.ts > lastTs) lastTs = r.ts;
            const u = r.u;
            // The context the model was actually HOLDING on its newest request,
            // which is a different quantity from the totals beside it: those
            // accumulate, this is one request's worth.
            if (r.ts >= newest) {
                newest = r.ts;
                th.ctxTokens = (u.input_tokens || 0) + (u.output_tokens || 0);
            }
            if (r.ts >= seriesStart) {
                const idx = Math.min(SERIES_MINUTES - 1, Math.floor((r.ts - seriesStart) / 60000));
                series[idx] += u.total_tokens || 0;
            }
        }
    }

    for (const th of threads.values()) {
        for (const k of Object.keys(total)) {
            total[k] += th.total[k] || 0;
            today.tokens[k] += th.today[k] || 0;
        }
        today.requestsSeen += th.requests;
        const name = th.model || 'unknown';
        let mm = models.get(name);
        if (!mm) { mm = { name, tokens: 0, requests: 0, lastTs: 0 }; models.set(name, mm); }
        // Today when there is a today; otherwise the thread total, so the row
        // still names the model on a day nothing has run yet.
        mm.tokens += th.today.total || 0;
        mm.allTokens = (mm.allTokens || 0) + (th.total.total || 0);
        mm.requests += th.requests;
        if (th.lastTs > mm.lastTs) mm.lastTs = th.lastTs;
    }

    // Burn rate over the last 10 minutes of per-record data, which is the part
    // the bounded tail always has.
    const burnStart = now - 10 * 60000;
    let burnTok = 0, burnSeen = 0;
    for (const c of _cache.values()) {
        for (const r of c.records) {
            if (r.ts < burnStart) continue;
            burnTok += r.u.total_tokens || 0;
            burnSeen++;
        }
    }
    const burnRatePerMin = burnSeen ? Math.round(burnTok / 10) : 0;

    const sessionList = [...threads.values()]
        .filter(t => t.total.total > 0)
        .map(t => ({
            id: t.id,
            // The TAIL, not the head. codex ids are time-ordered, so every
            // session opened the same hour shares a prefix — six rows all
            // labelled "01a0" tell you nothing about which is which.
            shortId: (t.id || '').replace(/-/g, '').slice(-4) || '?',
            project: t.cwd ? path.basename(t.cwd) : '',
            cwd: t.cwd,
            model: t.model,
            lastTs: t.lastTs,
            requestsSeen: t.requests,
            total: { tok: t.total.total, out: t.total.output },
            today: { tok: t.today.total, out: t.today.output, cached: t.today.cached },
            ctxTokens: t.ctxTokens,
            ctxPct: t.ctxTokens && t.contextWindow
                ? Math.min(100, Math.round((t.ctxTokens / t.contextWindow) * 100))
                : null,
        }))
        .sort((a, b) => (b.today.tok - a.today.tok) || (b.total.tok - a.total.tok))
        .slice(0, MAX_SESSIONS);

    return {
        now,
        available: anyFiles,
        limits,
        planType,
        credits,
        limitsTs,
        today,
        total,
        burnRatePerMin,
        // `tokens` is today; `totalTokens` is the retained window. Sorted by
        // today first so the row names what is running now, and only falls back
        // to the window on a day nothing has run yet.
        models: [...models.values()]
            .map(m => ({ name: m.name, tokens: m.tokens || 0, totalTokens: m.allTokens || 0, requests: m.requests, lastTs: m.lastTs }))
            .filter(m => m.tokens > 0 || m.totalTokens > 0)
            .sort((a, b) => (b.tokens - a.tokens) || (b.totalTokens - a.totalTokens)),
        sessions: sessionList,
        series,
        seriesMinutes: SERIES_MINUTES,
        // True when at least one transcript was picked up mid-file. Totals and
        // TODAY are still exact (they come from the cumulative counters); it is
        // the per-record series that starts where we started watching.
        partialHistory: partial,
        lastTs,
        hasData: sessionList.length > 0,
        updatedAt: now,
    };
}

function snapshot() {
    const now = Date.now();
    if (_lastComputed && (now - _lastAt) < MIN_RECOMPUTE_MS) return _lastComputed;
    _lastComputed = compute();
    _lastAt = now;
    return _lastComputed;
}

function mount(app, requireAuthed) {
    app.get('/api/codex-usage', requireAuthed, (req, res) => {
        try { res.json({ ok: true, data: snapshot() }); }
        catch (e) { res.status(500).json({ ok: false, error: String(e && e.message || e) }); }
    });
}

// _reset exists for tests: the tail cache is keyed by path and deliberately
// survives across polls, which is exactly what a fixture must not inherit.
function _reset() { _cache.clear(); _lastComputed = null; _lastAt = 0; }

module.exports = {
    mount, snapshot, windowLabel, seekTs, sessionsDir,
    _internals: { lineTs, subBuckets, normalizeLimit, nextLineStart, readBuf, scanForTs, firstTsAt, eachLine, _reset },
};
