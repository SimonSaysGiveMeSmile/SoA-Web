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
 */
const fs = require('fs');
const { STATE_DIR, stateFile } = require('./stateDir');

const LOCK_FILE = stateFile('daemon.lock');

function pidAlive(pid) {
    if (!pid || typeof pid !== 'number') return false;
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
}

/**
 * Acquire the per-state-dir lock or exit the process with a clear message.
 * Call once, early in boot, before any state file is read or written.
 */
function acquireOrExit(port) {
    try {
        const prev = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
        if (prev && prev.pid !== process.pid && pidAlive(prev.pid)) {
            console.error(
                `SoA-Web: another daemon (pid ${prev.pid}, port ${prev.port || '?'}) already owns ${STATE_DIR}.\n` +
                `Refusing to start — two daemons on one state dir corrupt tabs/scrollback.\n` +
                `Either stop it first, or run this instance with its own state:\n` +
                `  SOA_WEB_STATE_DIR=~/.soa-web-dev node server/src/index.js\n` +
                `(scripts/local.js does this automatically.)`
            );
            process.exit(78); // EX_CONFIG — distinguishable from crash loops
        }
    } catch (_) { /* missing or unreadable lock: ours to take */ }
    write(port);
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
