'use strict';
// Deliberately contains no OS display, capture, app launch or input calls.
module.exports = function helper(kind) {
    const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
    const args = process.argv.slice(2), logPath = process.env.SOA_TEST_REMOTE_LOG;
    const log = message => fs.appendFileSync(logPath, JSON.stringify({ kind, message, pid: process.pid }) + '\n');
    const out = value => console.log(JSON.stringify(value));
    const mode = { id: 'builtin', width: 1728, height: 1117, pixelWidth: 3456, pixelHeight: 2234, scale: 2, hidpi: true, current: true };
    if (kind === 'open') return;
    if (kind === 'display') { out({ ok: true, mode, modes: [mode], current: 'builtin' }); return; }
    if (kind === 'computeruse') {
        if (args[0] === 'screen-info') out({ width: mode.width, height: mode.height, scale_factor: 2 });
        else if (args[0] === 'apps') out([{ active: true, running: true, pid: 123 }]);
        else if (args[0] === 'cursor') out({ x: 100, y: 100 });
        else log(args);
        return;
    }
    if (kind === 'window-at') { readline.createInterface({ input: process.stdin }).on('line', () => console.log('123')); return; }
    if (kind === 'screen') {
        if (args[0] === '--info') { out({ width: mode.width, height: mode.height, scale_factor: 2 }); return; }
        log(args);
        if (args.includes('--strict-display') && fs.existsSync(process.env.SOA_TEST_REMOTE_FAIL_CAPTURE || '')) process.exit(3);
        const frame = fs.readFileSync(path.join(__dirname, 'desktop.h264'));
        function send() {
            const header = Buffer.alloc(13); header.writeUInt32BE(frame.length + 9); header[4] = 1; header.writeDoubleBE(Date.now(), 5);
            process.stdout.write(Buffer.concat([header, frame]));
        }
        setInterval(send, 200); send();
        process.stdout.on('error', () => process.exit(0));
        process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); return;
    }
    if (kind === 'virtual') {
        const statePath = process.env.SOA_VDISPLAY_DRY_STATE;
        let state;
        try { state = JSON.parse(fs.readFileSync(statePath)); } catch (_) { state = null; }
        const query = id => state && (!id || state.id === id) ? state : { id, online: false, main: 1 };
        if (args[0] === '--query') { out(query(+args[1])); return; }
        if (args[0] === '--restore') { log(args); out({ ok: true }); return; }
        const write = () => fs.writeFileSync(statePath, JSON.stringify(state));
        const remove = () => { try { fs.unlinkSync(statePath); } catch (_) {} };
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', line => {
            log(line);
            const [cmd, w, h, dpi] = line.split(' ');
            if (cmd === 'create' || cmd === 'resize') {
                const n = +dpi ? 2 : 1;
                state = { id: 42, online: true, main: 1, mirrorOf: 0, bounds: { x: 1728, y: 0 },
                    mode: { width: +w / n, height: +h / n, pixelWidth: +w, pixelHeight: +h } };
                write(); out({ ok: true, id: 42 });
            } else if (cmd === 'extend') {
                state.bounds.x = w === 'left' ? -state.mode.width : 1728; write(); out({ ok: true, id: 42 });
            } else if (cmd === 'destroy' || cmd === 'quit') { remove(); out({ ok: true }); }
            else out({ ok: false, error: 'unexpected test command' });
        });
        rl.on('close', () => { remove(); process.exit(0); });
        process.on('SIGTERM', () => { remove(); process.exit(0); });
    }
};
