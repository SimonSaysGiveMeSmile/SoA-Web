'use strict';
// Where the usage watchdogs (soa-usage-alert, soa-usage-throttle) keep their log
// and state. They used to hardcode ~/.soa-web/logs, so on an install whose state
// dir moved (SOA_WEB_STATE_DIR) they kept writing into the old one. Now:
// $SOA_WEB_STATE_DIR/logs, else the legacy ~/.soa-web/logs (unchanged when unset).
const fs = require('fs');
const os = require('os');
const path = require('path');

const legacyLogDir = (home = os.homedir()) => path.join(home, '.soa-web', 'logs');
function usageLogDir(env = process.env, home = os.homedir()) {
    return env.SOA_WEB_STATE_DIR ? path.join(env.SOA_WEB_STATE_DIR, 'logs') : legacyLogDir(home);
}

/** The state file `name` in the log dir; a legacy copy is migrated once (copied, so an old reader still works). */
function usageStateFile(name, env = process.env, home = os.homedir()) {
    const dir = usageLogDir(env, home), file = path.join(dir, name), old = path.join(legacyLogDir(home), name);
    if (file !== old && !fs.existsSync(file) && fs.existsSync(old)) {
        try { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(old, file); } catch (_) {}
    }
    return file;
}

/** For readers (soa-sessions): the freshest of the current and legacy copies. */
function newestUsageStateFile(name, env = process.env, home = os.homedir()) {
    const candidates = [path.join(usageLogDir(env, home), name), path.join(legacyLogDir(home), name)];
    let best = null, bestAt = -1;
    for (const f of candidates) { try { const at = fs.statSync(f).mtimeMs; if (at > bestAt) { best = f; bestAt = at; } } catch (_) {} }
    return best;
}

module.exports = { usageLogDir, usageStateFile, newestUsageStateFile, legacyLogDir };
