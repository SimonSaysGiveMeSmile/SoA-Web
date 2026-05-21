'use strict';

const RING_SIZE = 200;
const ring = [];
const sseClients = new Set();

const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

function push(level, args) {
    const entry = {
        ts: Date.now(),
        level,
        msg: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '),
    };
    ring.push(entry);
    if (ring.length > RING_SIZE) ring.shift();
    const data = JSON.stringify(entry);
    for (const res of sseClients) {
        try { res.write(`data: ${data}\n\n`); } catch (_) { sseClients.delete(res); }
    }
}

console.log = (...args) => { _origLog(...args); push('log', args); };
console.warn = (...args) => { _origWarn(...args); push('warn', args); };
console.error = (...args) => { _origError(...args); push('error', args); };

function mount(app, requireAuthed) {
    app.get('/api/logs', requireAuthed, (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        for (const entry of ring) {
            res.write(`data: ${JSON.stringify(entry)}\n\n`);
        }
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
    });
}

module.exports = { mount };
