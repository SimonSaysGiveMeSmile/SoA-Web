/**
 * procMem — per-tab process-tree memory sampling.
 *
 * A terminal tab's "memory occupation" is the RSS of its shell PLUS every
 * descendant (the agent / node / etc. running under it). We take ONE `ps`
 * snapshot of every process per sample tick and sum each tab's subtree from
 * its PTY pid — so N tabs cost ONE `ps` call, not N. RSS is summed (KB→bytes);
 * it slightly overcounts shared pages but is a fine at-a-glance indicator and
 * matches what Activity Monitor / `top` report per process.
 *
 * snapshot() does the (cheap) ps I/O; subtreeBytes() is pure and unit-tested.
 * Works on macOS + Linux (both ship a BSD/coreutils `ps` with rss in KiB).
 */

const { execFileSync } = require('child_process');

// One ps over all procs → { info: Map<pid,{ppid,rssKb}>, kids: Map<ppid,[pid]> }.
// Empty maps on any failure (ps missing / denied) so callers degrade to "—".
function snapshot() {
    const info = new Map();
    const kids = new Map();
    let out = '';
    try {
        out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], {
            encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
        });
    } catch (_) {
        return { info, kids };
    }
    for (const line of out.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
        if (!m) continue;
        const pid = +m[1], ppid = +m[2], rssKb = +m[3];
        info.set(pid, { ppid, rssKb });
        let arr = kids.get(ppid);
        if (!arr) { arr = []; kids.set(ppid, arr); }
        arr.push(pid);
    }
    return { info, kids };
}

// Sum RSS (bytes) of rootPid + all descendants in the snapshot. Pure; cycle-safe.
function subtreeBytes(rootPid, snap) {
    if (!rootPid || !snap || !snap.info || !snap.info.has(rootPid)) return 0;
    const { info, kids } = snap;
    let totalKb = 0;
    const stack = [rootPid];
    const seen = new Set();
    while (stack.length) {
        const p = stack.pop();
        if (seen.has(p)) continue;
        seen.add(p);
        const ent = info.get(p);
        if (ent) totalKb += ent.rssKb;
        const ch = kids.get(p);
        if (ch) for (const c of ch) if (!seen.has(c)) stack.push(c);
    }
    return totalKb * 1024;
}

module.exports = { snapshot, subtreeBytes };
