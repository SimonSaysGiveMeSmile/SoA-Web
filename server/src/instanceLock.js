/**
 * instanceLock.js — one daemon per state dir, enforced.
 *
 * Two daemons sharing a state dir was the root cause of the June '26
 * corruption incidents: both flushed tabs.json/scrollback.json and the
 * loser's tabs were clobbered. The lock makes the second daemon refuse to
 * boot with an actionable message instead of silently corrupting.
 *
 * Lock format: JSON { pid, port, startedAt } at <STATE_DIR>/daemon.lock.
 * A lock whose pid is dead is stale and is taken over silently (crashes
 * and SIGKILL leave locks behind; that must not require manual cleanup).
 *
 * Atomicity: the original read→check→write let two daemons booting in the
 * same instant both "win" (observed 2026-06-11: launchd respawned the s0a
 * agent while launchd restarted prod — both ran on ~/.soa-web). Now the
 * fast path is an O_EXCL create (only one process can win), and the
 * contention path settles by re-reading after a short pause: the last
 * writer owns the file, everyone else exits.
 */
const fs = require('fs');
const { STATE_DIR, stateFile } = require('./stateDir');

const LOCK_FILE = stateFile('daemon.lock');

function pidAlive(pid) {
    if (!pid || typeof pid !== 'number') return false;
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
}

function refuse(prev) {
    console.error(
        `SoA-Web: another daemon (pid ${prev.pid}, port ${prev.port || '?'}) already owns ${STATE_DIR}.\n` +
        `Refusing to start — two daemons on one state dir corrupt tabs/scrollback.\n` +
        `Either stop it first, or run this instance with its own state:\n` +
        `  SOA_WEB_STATE_DIR=~/.soa-web-dev node server/src/index.js\n` +
        `(scripts/local.js does this automatically.)`
    );
    process.exit(78); // EX_CONFIG — distinguishable from crash loops
}

function readLock() {
    try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); }
    catch (_) { return null; }
}

function sleepMs(ms) {
    // Synchronous on purpose: this runs once at boot, before the server
    // exists; an async lock would let state files be touched mid-race.
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {}
}

/**
 * Acquire the per-state-dir lock or exit the process with a clear message.
 * Call once, early in boot, before any state file is read or written.
 * (index.js calls it again after listen() to record the real port — that
 * re-entry sees its own pid in the lock and just rewrites it.)
 */
function acquireOrExit(port) {
    let contended = false;
    try {
        // Fast path: atomic create — exactly one process can win 'wx'.
        const fd = fs.openSync(LOCK_FILE, 'wx');
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
        fs.closeSync(fd);
    } catch (_) {
        // Lock exists (or dir unwritable). Inspect the owner.
        const prev = readLock();
        if (prev && prev.pid !== process.pid && pidAlive(prev.pid)) refuse(prev);
        // Stale, corrupt, or our own re-entry: overwrite.
        contended = prev ? prev.pid !== process.pid : true;
        write(port);
    }
    if (contended) {
        // Two daemons can race through the stale path together; the last
        // writer owns the file. Pause, re-read, and yield if we lost.
        sleepMs(200);
        const cur = readLock();
        if (cur && cur.pid !== process.pid && pidAlive(cur.pid)) refuse(cur);
        if (!cur) write(port); // someone unlinked it mid-race — reclaim
    }
}

function write(port) {
    try {
        fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
    } catch (_) { /* state dir unwritable: boot will fail elsewhere with a real error */ }
}

/** Release on graceful shutdown only if the lock is still ours. */
function release() {
    try {
        const cur = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
        if (cur && cur.pid === process.pid) fs.unlinkSync(LOCK_FILE);
    } catch (_) {}
}

module.exports = { acquireOrExit, release, LOCK_FILE };
