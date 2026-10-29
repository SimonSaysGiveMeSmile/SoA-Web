const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { CodexSessionStatus } = require('../src/codexSessionStatus');

test('Codex telemetry uses only initialization and read-only exact-thread requests', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-codex-status-'));
    const socket = path.join(dir, 'control.sock');
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    const methods = [];
    wss.on('connection', ws => ws.on('message', raw => {
        const message = JSON.parse(raw);
        methods.push(message.method);
        if (message.id == null) return;
        if (message.method === 'initialize') ws.send(JSON.stringify({ id: message.id, result: {} }));
        else {
            assert.equal(message.method, 'thread/read');
            assert.deepEqual(message.params, { threadId: 'thread-a', includeTurns: false });
            ws.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-a', model: 'gpt-6-astra', reasoningEffort: 'max' } } }));
        }
    }));
    await new Promise(resolve => server.listen(socket, resolve));
    const client = new CodexSessionStatus({ socket });
    t.after(async () => {
        client.close();
        for (const ws of wss.clients) ws.terminate();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    assert.equal((await client.read('thread-a')).model, 'gpt-6-astra');
    assert.equal((await client.read('thread-a')).reasoningEffort, 'max');
    assert.deepEqual(methods, ['initialize', 'initialized', 'thread/read', 'thread/read']);
    // Close and immediately reconnect while the previous close event is still
    // queued. Its late event must not cancel the new metadata request.
    client.close();
    assert.equal((await client.read('thread-a')).model, 'gpt-6-astra');
});
