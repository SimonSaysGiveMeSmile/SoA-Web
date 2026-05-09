#!/usr/bin/env node
/**
 * selfhost.js — run a SoA-Web backend on the visitor's own machine.
 *
 * What this does:
 *   1. Generates a fresh random session token (32 bytes hex).
 *   2. Spawns the normal server with SOA_WEB_SESSION_TOKEN set, plus the
 *      usual allowed-origin / autopair env so the built-in Cloudflare
 *      tunnel can expose it publicly.
 *   3. Waits for the tunnel to come up, then prints three things the user
 *      can copy:
 *        - bare backend URL + token (for the "Connect backend" dialog)
 *        - one-shot deep link for www.s0a.app that pre-fills both
 *        - localhost URL if they want to connect from the same machine
 *
 * This file is intended to be run by *the visitor* on *their own computer*.
 * It never runs on the deployment host — www.s0a.app is static only. The
 * token gate means even with a publicly reachable tunnel, only whoever has
 * the token can open a shell, so pasting the tunnel URL alone into a
 * browser gets a 401.
 *
 * Usage:
 *   node scripts/selfhost.js                  # defaults: auto-tunnel, port 7332
 *   node scripts/selfhost.js --port 4010      # custom port
 *   node scripts/selfhost.js --frontend URL   # override deep link target
 *   node scripts/selfhost.js --no-tunnel      # skip cloudflared, localhost only
 */

const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

function parseArgs(argv) {
    const out = { port: '7332', frontend: 'https://www.s0a.app', tunnel: true };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--port') out.port = argv[++i];
        else if (a === '--frontend') out.frontend = argv[++i].replace(/\/+$/, '');
        else if (a === '--no-tunnel') out.tunnel = false;
        else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    }
    return out;
}

function printHelp() {
    console.log([
        'selfhost.js — run a SoA-Web backend and get a one-shot deep link.',
        '',
        'Options:',
        '  --port <n>        Local port to bind (default 7332).',
        '  --frontend <url>  Deployed frontend to deep-link into',
        '                    (default https://www.s0a.app).',
        '  --no-tunnel       Skip the Cloudflare tunnel. Localhost only.',
        '  --help            Show this help.',
    ].join('\n'));
}

function color(code, s) { return `\x1b[${code}m${s}\x1b[0m`; }
const bold   = s => color('1', s);
const cyan   = s => color('36', s);
const green  = s => color('32', s);
const dim    = s => color('2', s);
const yellow = s => color('33', s);

function printBanner(lines) {
    const width = Math.max(...lines.map(l => stripAnsi(l).length)) + 4;
    const bar = '─'.repeat(width);
    console.log('\n' + dim('┌' + bar + '┐'));
    for (const l of lines) {
        const padRaw = width - stripAnsi(l).length - 2;
        console.log(dim('│ ') + l + ' '.repeat(Math.max(0, padRaw)) + dim(' │'));
    }
    console.log(dim('└' + bar + '┘') + '\n');
}

function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }

function makeDeepLink(frontend, backend, token) {
    const u = new URL(frontend);
    u.searchParams.set('backend', backend);
    u.searchParams.set('t', token);
    return u.toString();
}

async function probeLocal(port, timeoutMs = 2000) {
    return new Promise(resolve => {
        const req = http.get(`http://127.0.0.1:${port}/api/ping`, { timeout: timeoutMs }, res => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

async function waitForLocal(port, deadlineMs = 10_000) {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
        const r = await probeLocal(port, 500);
        if (r && r.ok) return true;
        await new Promise(r => setTimeout(r, 250));
    }
    return false;
}

async function readPublicUrl(port, token, deadlineMs = 20_000) {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
        const snap = await new Promise(resolve => {
            const req = http.get(`http://127.0.0.1:${port}/api/pair/status?t=${token}`,
                { timeout: 2000 }, res => {
                    let body = '';
                    res.on('data', c => { body += c; });
                    res.on('end', () => {
                        try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
                    });
                });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
        });
        const snapData = snap && snap.data;
        if (snapData && snapData.publicUrl) return snapData.publicUrl;
        if (snapData && snapData.state === 'error') return null;
        await new Promise(r => setTimeout(r, 500));
    }
    return null;
}

async function main() {
    const args = parseArgs(process.argv);
    const token = crypto.randomBytes(32).toString('hex');

    console.log(bold(cyan('\n// SoA-Web self-host')) + dim(`  (token = ${token.slice(0, 8)}…)`));

    const env = {
        ...process.env,
        SOA_WEB_PORT: args.port,
        SOA_WEB_HOST: '127.0.0.1',
        SOA_WEB_SESSION_TOKEN: token,
        SOA_WEB_ALLOWED_ORIGINS: args.frontend,
        SOA_WEB_SECURE_COOKIE: '1',
        SOA_WEB_AUTOPAIR: args.tunnel ? '1' : '0',
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

    const ready = await waitForLocal(args.port, 10_000);
    if (!ready) {
        console.error(yellow('\nserver did not come up within 10s — check the log above.'));
        stop(1);
        return;
    }

    const localBackend = `http://127.0.0.1:${args.port}`;
    let publicBackend = null;
    if (args.tunnel) {
        console.log(dim('waiting for Cloudflare tunnel…'));
        publicBackend = await readPublicUrl(args.port, token, 30_000);
    }

    const lines = [
        bold(cyan('SoA-Web backend is live')),
        '',
        `${bold('Local:')}   ${green(localBackend)}`,
    ];
    if (publicBackend) lines.push(`${bold('Public:')}  ${green(publicBackend)}`);
    lines.push(`${bold('Token:')}   ${green(token)}`);
    lines.push('');
    lines.push(dim('Deep links (open in browser, backend auto-configures):'));
    lines.push(`  ${cyan(makeDeepLink(args.frontend, localBackend, token))}`);
    if (publicBackend) {
        lines.push(`  ${cyan(makeDeepLink(args.frontend, publicBackend, token))}`);
    }
    lines.push('');
    lines.push(dim('Ctrl+C stops the server.'));
    printBanner(lines);
}

main().catch(err => {
    console.error('selfhost: boot failed:', err);
    process.exit(1);
});
