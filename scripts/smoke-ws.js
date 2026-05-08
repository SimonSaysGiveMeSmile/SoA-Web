/**
 * Smoke test: open a PTY over WS and verify we get a prompt back.
 * Run after starting the server with SOA_WEB_AUTH=open SOA_WEB_PORT=7411.
 */
const http = require('http');
const WebSocket = require(require('path').resolve(__dirname, '../node_modules/ws'));

const HOST = '127.0.0.1', PORT = 7411;

function login() {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: HOST, port: PORT, method: 'POST',
            path: '/api/login', headers: { 'content-type': 'application/json' },
        }, res => {
            const cookies = res.headers['set-cookie'] || [];
            const body = [];
            res.on('data', c => body.push(c));
            res.on('end', () => {
                const jar = cookies.map(c => c.split(';')[0]).join('; ');
                resolve(jar);
            });
        });
        req.on('error', reject);
        req.end('{}');
    });
}

(async () => {
    const jar = await login();
    console.log('cookie:', jar.slice(0, 40) + '…');

    const ws = new WebSocket(`ws://${HOST}:${PORT}/ws`, { headers: { cookie: jar } });

    let helloSeen = false, dataSeen = false, tabId = null;

    ws.on('open', () => console.log('ws open'));
    ws.on('message', raw => {
        const m = JSON.parse(raw.toString());
        console.log('←', m.t, JSON.stringify(m.d).slice(0, 80));
        if (m.t === 'hello') {
            helloSeen = true;
            ws.send(JSON.stringify({ v: 1, t: 'input', d: { kind: 'new-tab', cols: 80, rows: 24 } }));
        }
        if (m.t === 'snapshot' && m.d.activeId && tabId == null) {
            tabId = m.d.activeId;
            setTimeout(() => {
                ws.send(JSON.stringify({ v: 1, t: 'input', d: { kind: 'shell-command', id: tabId, line: 'echo SOA-WEB-OK' } }));
            }, 300);
        }
        if (m.t === 'term-data' && typeof m.d.data === 'string' && m.d.data.includes('SOA-WEB-OK')) {
            dataSeen = true;
            console.log('✓ round-trip OK: server ran shell and streamed output');
            ws.close();
        }
    });

    ws.on('close', code => {
        console.log('closed', code);
        process.exit(helloSeen && dataSeen ? 0 : 1);
    });

    ws.on('error', e => { console.error('err:', e.message); process.exit(2); });

    setTimeout(() => { console.error('timeout'); process.exit(3); }, 6000);
})();
