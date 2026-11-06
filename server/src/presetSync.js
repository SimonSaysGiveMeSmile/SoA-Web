'use strict';
// Boot-time mirror of the skill library (user vault + mcp/presets) into the
// native skills dirs (~/.claude/skills, ${CODEX_HOME:-~/.codex}/skills), so
// every new agent sees the presets without anyone running `soa-mcp sync`.
//
// Best effort and off the boot path: one detached child (`node scripts/soa-mcp
// sync`), killed after a timeout, its failure never affects the daemon. The
// ownership rules live in soa-mcp itself: only directories carrying its
// .soa-mcp-managed marker are written or removed; user-owned and hand-edited
// skill dirs are reported as conflicts (exit 3) and left untouched.
//
// Off with SOA_MCP_SYNC=0 (no automatic sync) or SOA_MCP_PRESETS_DISABLE=1.
// Skipped for a daemon on a non-default state dir and under node --test unless
// both SOA_MCP_*_SKILLS_DIR targets are overridden (or SOA_MCP_SYNC=1).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'soa-mcp');

function startPresetSync(opts = {}) {
    const env = opts.env || process.env;
    const log = opts.log || ((m) => console.log(m));
    if (env.SOA_MCP_SYNC === '0') return { skipped: 'SOA_MCP_SYNC=0' };
    if (env.SOA_MCP_PRESETS_DISABLE === '1') return { skipped: 'SOA_MCP_PRESETS_DISABLE=1' };
    // Sync mirrors the vault of soa-mcp's state dir and REMOVES managed mirrors
    // that are not in it. A dev/test daemon (its own SOA_WEB_STATE_DIR) syncing
    // into the real ~/.claude/skills would delete the real vault's mirrors. So
    // only soa-mcp's default state dir syncs to the default targets; any other
    // needs both target dirs overridden, or an explicit SOA_MCP_SYNC=1.
    if (env.SOA_MCP_SYNC !== '1' && !(env.SOA_MCP_CLAUDE_SKILLS_DIR && env.SOA_MCP_CODEX_SKILLS_DIR)) {
        const home = opts.home || os.homedir();
        const raw = String(env.SOA_WEB_STATE_DIR || '').trim();
        const state = raw ? path.resolve(raw.replace(/^~(?=$|\/)/, home)) : path.join(home, '.soa-web-local');
        if (env.NODE_TEST_CONTEXT) return { skipped: 'under node --test' };
        if (state !== path.join(home, '.soa-web-local')) return { skipped: 'not the default state dir' };
    }
    const script = opts.script || DEFAULT_SCRIPT;
    if (!fs.existsSync(script)) return { skipped: 'soa-mcp not found' };
    const timeoutMs = opts.timeoutMs || 30000;
    let child;
    try {
        child = (opts.spawn || spawn)(opts.node || process.execPath, [script, 'sync'], { env, detached: true, stdio: 'ignore' });
    } catch (e) {
        log(`skills sync: could not start (${(e && (e.code || e.message)) || 'error'})`);
        return { error: 'spawn' };
    }
    let done = false;
    const finish = (msg) => { if (done) return; done = true; clearTimeout(timer); log(`skills sync: ${msg}`); };
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) {} finish(`timed out after ${timeoutMs} ms`); }, timeoutMs);
    if (timer.unref) timer.unref();
    child.on('error', (e) => finish(`failed (${(e && (e.code || e.message)) || 'error'})`));
    child.on('exit', (code, signal) => finish(code === 0 ? 'native skills in sync'
        : code === 3 ? 'done; some skill dirs are not soa-mcp-managed or were hand-edited, left untouched (soa-mcp sync shows which)'
        : `exited ${signal || code} (ignored)`));
    if (child.unref) child.unref();
    return { started: true };
}

module.exports = { startPresetSync };
