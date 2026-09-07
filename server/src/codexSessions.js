/**
 * Resolve the latest Codex CLI thread per project cwd — the Codex twin of
 * claudeSessions.js, so the fleet can `codex resume <id>` a Codex tab instead
 * of blindly `claude --resume`-ing it.
 *
 * Codex stores rollouts at
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
 * The first record is `session_meta` carrying {id|session_id, cwd}.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const HEAD_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readMeta(file) {
    let fd = null;
    try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(HEAD_BYTES);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        const head = buf.toString('utf8', 0, n);
        const cwd = (head.match(/"cwd"\s*:\s*"([^"]+)"/) || [])[1] || null;
        const id = (head.match(/"(?:session_id|id)"\s*:\s*"([0-9a-f-]{36})"/i) || [])[1] || null;
        return { cwd, id: id && UUID.test(id) ? id : null };
    } catch (_) {
        return { cwd: null, id: null };
    } finally {
        if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
    }
}

function numericDirs(dir) {
    try { return fs.readdirSync(dir).filter(x => /^\d+$/.test(x)).sort((a, b) => +b - +a); }
    catch (_) { return []; }
}

/**
 * Map of real cwd -> { sessionId, mtime } for the most recent Codex thread in
 * each project touched within the last `hours`. Empty Map on any FS error.
 */
function latestSessionByCwd(hours = 72) {
    const cutoff = Date.now() - hours * 3600 * 1000;
    const map = new Map();
    for (const y of numericDirs(SESSIONS_DIR)) {
        for (const m of numericDirs(path.join(SESSIONS_DIR, y))) {
            for (const d of numericDirs(path.join(SESSIONS_DIR, y, m))) {
                // Whole day older than the window → skip the directory outright.
                const dayEnd = new Date(+y, +m - 1, +d + 1).getTime();
                if (dayEnd < cutoff) continue;
                const dir = path.join(SESSIONS_DIR, y, m, d);
                let files;
                try { files = fs.readdirSync(dir).filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl')); }
                catch (_) { continue; }
                for (const f of files) {
                    const file = path.join(dir, f);
                    let mt = 0;
                    try { mt = fs.statSync(file).mtimeMs; } catch (_) { continue; }
                    if (mt < cutoff) continue;
                    const meta = readMeta(file);
                    if (!meta.cwd || !meta.id) continue;
                    const prev = map.get(meta.cwd);
                    if (!prev || mt > prev.mtime) map.set(meta.cwd, { sessionId: meta.id, mtime: mt });
                }
            }
        }
    }
    return map;
}

module.exports = { latestSessionByCwd, SESSIONS_DIR };
