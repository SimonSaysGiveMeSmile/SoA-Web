'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(30); }
    throw new Error('Timed out waiting for test condition');
}
async function launch({ graceMs = 800 } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-extend-e2e-'));
    const work = path.join(dir, 'desktop-remote'); fs.mkdirSync(work);
    const paths = {}, logPath = path.join(dir, 'calls.jsonl'); fs.writeFileSync(logPath, '');
    for (const kind of ['virtual', 'screen', 'display', 'computeruse', 'open', 'window-at']) {
        const file = path.join(kind === 'window-at' ? work : dir, kind);
        fs.writeFileSync(file, `#!${process.execPath}\nrequire(${JSON.stringify(path.join(__dirname, 'helpers.cjs'))})(${JSON.stringify(kind)});\n`, { mode: 0o755 }); paths[kind] = file;
    }
    const inputs = [];
    const pointer = net.createServer(sock => {
        let buf = '';
        sock.on('data', d => {
            buf += d;
            for (let i; (i = buf.indexOf('\n')) >= 0;) {
                const line = buf.slice(0, i); buf = buf.slice(i + 1); inputs.push(line);
                sock.write(line === 'status' ? 'ready 1 dry\n' : line === 'where' ? 'at -790 120\n' : 'ok\n');
            }
        });
        sock.on('error', () => {});
    });
    await new Promise(r => pointer.listen(path.join(work, 'pointer.sock'), r));
    const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const env = { ...process.env, SOA_WEB_STATE_DIR: dir, SOA_DESKTOP_REMOTE_PORT: String(port), SOA_VDISPLAY_BIN: paths.virtual,
        SOA_SCREEN_STREAM_BIN: paths.screen, SOA_DISPLAY_BIN: paths.display, SOA_COMPUTERUSE: paths.computeruse,
        SOA_OPEN: paths.open, SOA_FFMPEG: paths.open, SOA_POINTER_LAUNCH: '0', SOA_POINTER_DRY: '1', SOA_DISPLAY_DRY: '1',
        SOA_DISPLAY_RESTORE_MS: String(graceMs), SOA_TEST_REMOTE_LOG: logPath, SOA_TEST_REMOTE_FAIL_CAPTURE: path.join(dir, 'fail-capture') };
    let output = '';
    const child = spawn(process.execPath, [path.resolve(__dirname, '../../../../scripts/soa-desktop-remote')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', d => { output += d; });
    const base = `http://127.0.0.1:${port}/`;
    const health = async () => { try { return await (await fetch(base + 'health')).json(); } catch (_) { return null; } };
    await until(health).catch(e => { child.kill(); throw new Error(e.message + '\n' + output); });
    const clients = [];
    async function connect(dev = 'phone-123', resume = false) {
        const { token } = await (await fetch(base + 'token')).json();
        const ws = new WebSocket(base.replace('http:', 'ws:') + 'ws?token=' + token + (resume ? '&target=extend' : ''));
        ws.messages = []; ws.frames = 0; ws.dev = dev;
        ws.on('message', (data, binary) => { if (binary) { ws.frames++; const b = Buffer.from(data); if (b[0] === 1) ws.send(JSON.stringify({ t: 'vack', seq: b.readUInt32BE(2) })); } else ws.messages.push(JSON.parse(data)); });
        await new Promise((r, reject) => { ws.once('open', r); ws.once('error', reject); }); clients.push(ws);
        ws.json = m => ws.send(JSON.stringify(m));
        ws.extend = (action = 'start', extra = {}) => ws.json({ t: 'extend', action, dev, area: { w: 400, h: 600 }, ...extra });
        ws.json({ t: 'mode', mode: 'h264', display: { w: 800, h: 1200 } });
        return ws;
    }
    const stop = async () => {
        for (const ws of clients) ws.terminate();
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await until(() => child.exitCode !== null || child.signalCode !== null, 7000).catch(() => child.kill('SIGKILL')); }
        pointer.close(); fs.rmSync(dir, { recursive: true, force: true });
    };
    return { base, child, dir, inputs, health, connect, stop, logs: () => output, calls: () => fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) };
}
module.exports = { launch, until, sleep };
