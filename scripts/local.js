#!/usr/bin/env node
/**
 * local.js — run a SoA-Web backend on this machine and open a terminal.
 *
 * The fast path for "I just want a shell in my browser right now":
 *   npm run local
 *
 * What this does:
 *   1. Spawns the Node server bound to 127.0.0.1:<port> (default 4010) —
 *      no Cloudflare tunnel, no token gate, localhost only.
 *   2. Waits for /api/ping to come up, then opens the default browser
 *      at http://127.0.0.1:<port>. The page will probe the same origin,
 *      find the server, and boot straight into server mode with the
 *      real sidebar (sysinfo, pairing, QR, etc.).
 *   3. Ctrl+C stops both.
 *
 * This is distinct from scripts/selfhost.js, which exposes the server
 * over a public tunnel and gates it with a random session token so it
 * can be linked to from www.s0a.app. Use local.js when you only care
 * about this machine; use selfhost.js when you want other devices
 * (phone, iPad, etc.) to reach the same shell.
 *
 * State isolation: by default this runs against ~/.soa-web-dev, NOT the
 * production ~/.soa-web — a dev daemon sharing the launchd daemon's state
 * dir clobbers tabs/scrollback (the 2026-06 corruption incidents). Pass
 * --prod-state only if you intentionally want the production state dir
 * (the server's instance lock will refuse if the prod daemon is running).
 *
 * Usage:
 *   node scripts/local.js              # default port 4010, state ~/.soa-web-dev
 *   node scripts/local.js --port 7000  # custom port
 *   node scripts/local.js --no-open    # skip launching the browser
 *   node scripts/local.js --prod-state # use ~/.soa-web (danger: prod state)
 */

const { spawn, execFile } = require('child_process');
const path = require('path');
const http = require('http');

function parseArgs(argv) {
    const out = { port: '4010', openBrowser: true, prodState: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--port') out.port = argv[++i];
        else if (a === '--no-open') out.openBrowser = false;
        else if (a === '--prod-state') out.prodState = true;
        else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    }
    return out;
}

function printHelp() {
    console.log([
        'local.js — run a SoA-Web backend on this machine and open a browser.',
        '',
        'Options:',
        '  --port <n>     Local port to bind (default 4010).',
        '  --no-open      Don\'t launch the browser; just print the URL.',
        '  --prod-state   Use the production state dir ~/.soa-web instead of',
        '                 the isolated ~/.soa-web-dev. Refused while the prod',
        '                 daemon is running (instance lock).',
        '  --help         Show this help.',
    ].join('\n'));
}

function color(code, s) { return `\x1b[${code}m${s}\x1b[0m`; }
const bold  = s => color('1', s);
const cyan  = s => color('36', s);
const green = s => color('32', s);
const dim   = s => color('2', s);

async function probe(port, timeoutMs = 500) {
    return new Promise(resolve => {
        const req = http.get(`http://127.0.0.1:${port}/api/ping`, { timeout: timeoutMs }, res => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

async function waitUp(port, deadlineMs = 10_000) {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
        if (await probe(port)) return true;
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

function openUrl(url) {
    const cmd =
        process.platform === 'darwin' ? 'open' :
        process.platform === 'win32'  ? 'cmd' :
        'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try {
        execFile(cmd, args, { stdio: 'ignore' }, () => {});
    } catch (_) {}
}

async function main() {
    const args = parseArgs(process.argv);
    const port = String(args.port);

    // Isolated state dir by default so a dev daemon can never corrupt the
    // production daemon's tabs/scrollback/session files.
    const stateDir = args.prodState
        ? ''
        : (process.env.SOA_WEB_STATE_DIR || path.join(require('os').homedir(), '.soa-web-dev'));
    const env = {
        ...process.env,
        SOA_WEB_PORT: port,
        SOA_WEB_HOST: '127.0.0.1',
        SOA_WEB_AUTOPAIR: process.env.SOA_WEB_AUTOPAIR || '0',
        ...(stateDir ? { SOA_WEB_STATE_DIR: stateDir, SOA_WEB_MODE: 'dev' } : {}),
        // Daemons inherited from a user shell often miss /usr/sbin (lsof) —
        // normalize so sysinfo features behave the same as under launchd.
        PATH: `${process.env.PATH || ''}:/usr/sbin:/sbin`,
    };

    const serverPath = path.resolve(__dirname, '../server/src/index.js');
    const child = spawn(process.execPath, [serverPath], {
        env, stdio: ['ignore', 'inherit', 'inherit'],
    });

    let stopping = false;
    const stop = (code = 0) => {
        if (stopping) return;
        stopping = true;
        try { child.kill('SIGTERM'); } catch (_) {}
        setTimeout(() => process.exit(code), 500).unref();
    };
    process.on('SIGINT', () => stop(0));
    process.on('SIGTERM', () => stop(0));
    child.on('exit', c => stop(c || 0));

    const ready = await waitUp(port, 10_000);
    if (!ready) {
        console.error(dim('server did not come up within 10s — check the log above.'));
        stop(1);
        return;
    }

    const url = `http://127.0.0.1:${port}`;
    const width = 48;
    const bar = '─'.repeat(width);
    console.log('\n' + dim('┌' + bar + '┐'));
    console.log(dim('│ ') + bold(cyan('SoA-Web is running on this machine')));
    console.log(dim('│ '));
    console.log(dim('│ ') + bold('URL:   ') + green(url));
    console.log(dim('│ ') + bold('Mode:  ') + 'local (no tunnel, no token)');
    console.log(dim('│ ') + bold('State: ') + (stateDir || '~/.soa-web (PRODUCTION)'));
    console.log(dim('│ '));
    console.log(dim('│ ') + 'Ctrl+C stops the server.');
    console.log(dim('└' + bar + '┘') + '\n');

    if (args.openBrowser) openUrl(url);
}

main().catch(err => {
    console.error('local: boot failed:', err);
    process.exit(1);
});
