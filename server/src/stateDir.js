/**
 * stateDir.js — single source of truth for where this daemon keeps state.
 *
 * Every module used to compute `path.join(os.homedir(), '.soa-web')` on its
 * own, which meant a dev/test daemon and the production daemon silently
 * shared session.json / tabs.json / scrollback.json / sign-key and clobbered
 * each other (terminal corruption, lost tabs, paired-device resets).
 *
 * Resolution order:
 *   1. SOA_WEB_STATE_DIR env (absolute, or ~-prefixed) — set by scripts/local.js
 *      so dev daemons land in ~/.soa-web-dev by default.
 *   2. ~/.soa-web — production default, used by the launchd daemon.
 *
 * The directory is created eagerly so callers can write into it without
 * their own mkdir dance, and MODE is exposed so the UI can badge non-prod
 * daemons.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function resolveStateDir() {
    const raw = process.env.SOA_WEB_STATE_DIR;
    if (raw && raw.trim()) {
        const expanded = raw.replace(/^~(?=$|\/)/, os.homedir());
        return path.resolve(expanded);
    }
    return path.join(os.homedir(), '.soa-web');
}

const STATE_DIR = resolveStateDir();
const IS_DEFAULT = STATE_DIR === path.join(os.homedir(), '.soa-web');
// 'prod' for the default dir, 'dev' for anything redirected via env.
const MODE = process.env.SOA_WEB_MODE || (IS_DEFAULT ? 'prod' : 'dev');

try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (_) { /* read-only fs: fail later, loudly */ }

function stateFile(name) { return path.join(STATE_DIR, name); }

module.exports = { STATE_DIR, MODE, stateFile };
