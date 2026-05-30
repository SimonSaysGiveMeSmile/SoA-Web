'use strict';

/**
 * Gated diagnostic logging for the mobile bridge.
 *
 * Routes through console.log so every line ALSO flows to the desktop's
 * /api/logs SSE viewer (see consoleLogs.js) — you can watch the bridge from
 * the desktop sidebar without a terminal attached.
 *
 * Enabled when SOA_WEB_DEBUG=1 or SOA_WEB_DEV=1 (i.e. `npm run dev`). A no-op
 * otherwise, so a production `npm start` stays quiet unless you opt in.
 *
 *   dbg(tag, ...args)            — one immediate line, prefixed [tag].
 *   agg(tag, key, bytes, extra)  — coalesce high-frequency events (term-data)
 *                                  into one summary line per FLUSH_MS per key,
 *                                  so streaming output doesn't flood the log.
 */

const ENABLED = process.env.SOA_WEB_DEBUG === '1' || process.env.SOA_WEB_DEV === '1';
const FLUSH_MS = parseInt(process.env.SOA_WEB_DEBUG_FLUSH_MS || '1000', 10);

function dbg(tag, ...args) {
    if (!ENABLED) return;
    console.log('[' + tag + ']', ...args);
}

const _buckets = new Map(); // key -> { frames, bytes, extra, timer }

function agg(tag, key, bytes, extra) {
    if (!ENABLED) return;
    let b = _buckets.get(key);
    if (!b) {
        b = { frames: 0, bytes: 0, extra: extra || '', timer: null };
        _buckets.set(key, b);
    }
    b.frames += 1;
    b.bytes += bytes || 0;
    if (extra) b.extra = extra;
    if (!b.timer) {
        b.timer = setTimeout(() => {
            console.log('[' + tag + ']', key, '+' + b.frames + ' frames', b.bytes + ' bytes', b.extra);
            _buckets.delete(key);
        }, FLUSH_MS);
        if (b.timer.unref) b.timer.unref();
    }
}

module.exports = { dbg, agg, enabled: ENABLED };
