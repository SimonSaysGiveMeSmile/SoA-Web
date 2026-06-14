/**
 * Resolve the latest Claude Code conversation per project cwd.
 *
 * Claude Code stores transcripts at
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 * The encoded dir name is lossy ("-" can be "/", "." or "-"), so we read the
 * real cwd back out of each transcript (it records "cwd":"…" near the top).
 *
 * Used by the daemon's boot-restore to auto-resume Claude in tabs whose shells
 * were respawned fresh after a restart — see scheduleAutoResume() in index.js.
 * This mirrors the discovery logic in scripts/soa-relaunch, but keyed by cwd so
 * an already-open restored tab can be matched to its conversation.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
// A compacted session can start with a summary block that pushes the first
// real (cwd-carrying) entry down; 256KB is a pragmatic cap for the daemon
// (soa-relaunch scans 4MB, but it's a one-shot CLI, not the event loop).
const CWD_SCAN_BYTES = 256 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function resolveCwd(jsonlPath) {
    let fd = null;
    try {
        fd = fs.openSync(jsonlPath, 'r');
        const buf = Buffer.alloc(CWD_SCAN_BYTES);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        const m = buf.toString('utf8', 0, n).match(/"cwd"\s*:\s*"([^"]+)"/);
        return m ? m[1] : null;
    } catch (_) {
        return null;
    } finally {
        if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
    }
}

/**
 * Map of real cwd -> { sessionId, mtime } for the most recent conversation in
 * each project touched within the last `hours`. Returns an empty Map on any
 * filesystem error so callers can treat "no resume" as the safe default.
 */
function latestSessionByCwd(hours = 72) {
    const cutoff = Date.now() - hours * 3600 * 1000;
    const map = new Map();
    let entries;
    try { entries = fs.readdirSync(PROJECTS_DIR); } catch (_) { return map; }
    for (const entry of entries) {
        // Skip workflow/subagent transcripts and throwaway tmp checkouts.
        if (entry.startsWith('wf_') || entry === 'subagents') continue;
        if (entry.startsWith('-private-tmp') || entry.startsWith('-tmp')) continue;
        const dir = path.join(PROJECTS_DIR, entry);
        let files;
        try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch (_) { continue; }
        if (!files.length) continue;
        const withMt = [];
        let latest = null, latestMt = 0;
        for (const f of files) {
            let mt = 0;
            try { mt = fs.statSync(path.join(dir, f)).mtimeMs; } catch (_) { continue; }
            withMt.push({ f, mt });
            if (mt > latestMt) { latestMt = mt; latest = f; }
        }
        if (!latest || latestMt < cutoff) continue;
        const sessionId = path.basename(latest, '.jsonl');
        if (!SAFE_ID.test(sessionId)) continue;
        // Resolve the real cwd from the newest transcript; fall back to older
        // siblings if it has no cwd (freshly-compacted summary preamble).
        withMt.sort((a, b) => b.mt - a.mt);
        let cwd = null;
        for (const { f } of withMt) { cwd = resolveCwd(path.join(dir, f)); if (cwd) break; }
        if (!cwd) continue;
        const prev = map.get(cwd);
        if (!prev || latestMt > prev.mtime) map.set(cwd, { sessionId, mtime: latestMt });
    }
    return map;
}

module.exports = { latestSessionByCwd, resolveCwd };
