'use strict';
// Resolve the CURRENT Claude model running in a given cwd, for the tab/fleet
// model badges. Source of truth is the live transcript, not the launch-time
// `--model` spawn arg: reading the newest ~/.claude/projects/<enc-cwd>/*.jsonl
// and taking the last assistant message's `message.model` reflects in-session
// `/model` switches (e.g. the Fable-5 unstick) that the spawn arg never sees.
//
// Cheap enough to call from the manager snapshot on every broadcast: per-cwd
// results are memoised and only re-read when that folder's newest transcript
// changes (path or mtime), with a short TTL floor so we stat at most ~once/15s
// per cwd.
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const TTL_MS = 15000;          // don't re-stat a cwd's folder more than this often
const TAIL_BYTES = 64 * 1024;  // last assistant line is always near the file end

// Claude encodes a project cwd into its folder name by replacing every
// non-alphanumeric char with '-'. e.g. /Users/x/.soa-web -> -Users-x--soa-web
// (the '/.' becomes '--'). Verified against ~/.claude/projects on this host.
function encodeCwd(cwd) {
    return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

// cwd -> { model, at, path, mtime }
const _cache = new Map();

function newestTranscript(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
    let best = null;
    for (const e of ents) {
        if (!e.isFile() || !e.name.endsWith('.jsonl') || e.name === 'journal.jsonl') continue;
        const full = path.join(dir, e.name);
        let st;
        try { st = fs.statSync(full); } catch (_) { continue; }
        if (!best || st.mtimeMs > best.mtimeMs) best = { full, mtimeMs: st.mtimeMs, size: st.size };
    }
    return best;
}

// Scan the file tail backwards for the freshest assistant `message.model`.
function lastModel(file, size) {
    const start = Math.max(0, size - TAIL_BYTES);
    let fd = null;
    try {
        fd = fs.openSync(file, 'r');
        const len = size - start;
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, start);
        const lines = buf.toString('utf8', 0, n).split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            const ln = lines[i];
            if (!ln || ln.indexOf('"model"') === -1) continue;
            let obj;
            try { obj = JSON.parse(ln); } catch (_) { continue; }
            const m = obj && obj.message && obj.message.model;
            if (m && typeof m === 'string' && m.toLowerCase() !== '<synthetic>') return m;
        }
    } catch (_) {
        /* transient read error — caller keeps the last known value */
    } finally {
        if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
    }
    return null;
}

// Public: raw model id (e.g. "claude-opus-4-8") for a cwd, or null if unknown.
// The client turns the raw id into a tier label + color, so formatting can be
// iterated without a server restart.
function modelFor(cwd) {
    if (!cwd) return null;
    const now = Date.now();
    const cached = _cache.get(cwd);
    if (cached && (now - cached.at) < TTL_MS) return cached.model;
    const dir = path.join(PROJECTS_DIR, encodeCwd(cwd));
    const newest = newestTranscript(dir);
    if (!newest) {
        _cache.set(cwd, { model: cached ? cached.model : null, at: now, path: null, mtime: 0 });
        return cached ? cached.model : null;
    }
    // Same file, unchanged mtime -> the last assistant line can't have changed.
    if (cached && cached.path === newest.full && cached.mtime === newest.mtimeMs) {
        cached.at = now;
        return cached.model;
    }
    const model = lastModel(newest.full, newest.size) || (cached ? cached.model : null);
    _cache.set(cwd, { model, at: now, path: newest.full, mtime: newest.mtimeMs });
    return model;
}

module.exports = { modelFor, encodeCwd };
