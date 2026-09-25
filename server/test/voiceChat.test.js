const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-voice-chat-'));
process.env.SOA_WEB_STATE_DIR = temporary;
const { mount, CWD } = require('../src/voiceChat');

test('voice chat route reuses its Codex manager, serializes prompts, and refuses foreign/closed targets', async t => {
    const writes = [];
    const tab = { id: 7, cwd: CWD, title: 'Voice manager', exited: false, write: s => writes.push(s) };
    const session = { tabMgr: { order: [7], get: id => id === 7 ? tab : null,
        list: () => [{ id: 7, cwd: CWD, title: tab.title }], open: () => assert.fail('must reuse the existing manager') }, send() {} };
    const app = express();
    let authed = 0;
    mount(app, (req, res, next) => { authed++; req.session = session; next(); }, req => req.headers.origin !== 'https://foreign.invalid');
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const url = `http://127.0.0.1:${server.address().port}/api/voice/chat`;
    const post = (route, body, origin) => fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
    const manager = await (await post('/session', {})).json();
    assert.equal(manager.created, false); assert.equal(manager.tab.id, 7);
    assert.equal((await post('/send', { id: 7, text: 'hello\nworld' })).status, 200);
    // The response itself acknowledges BOTH writes; no extra sleep should be needed.
    assert.deepEqual(writes, ['\x1b[200~hello\nworld\x1b[201~', '\r']);
    assert.equal((await post('/send', { id: 7, text: '\x1bunsafe' })).status, 400);
    assert.equal((await post('/send', { id: 99, text: 'missing' })).status, 404);
    const before = authed;
    assert.equal((await post('/send', { id: 7, text: 'foreign' }, 'https://foreign.invalid')).status, 403);
    assert.equal(authed, before);
    tab.exited = true;
    assert.equal((await post('/send', { id: 7, text: 'closed' })).status, 404);
    assert.equal(writes.length, 2);
    tab.exited = false;
    tab.write = () => { throw new Error('PTY disconnected'); };
    assert.equal((await post('/send', { id: 7, text: 'failed write' })).status, 503);
    tab.write = s => { writes.push(s); tab.exited = true; };
    assert.equal((await post('/send', { id: 7, text: 'closes before Enter' })).status, 503);
    assert.equal(writes.at(-1), '\x1b[200~closes before Enter\x1b[201~');
    tab.exited = false;
    tab.write = s => writes.push(s);
    assert.equal((await post('/send', { id: 7, text: 'recovered' })).status, 200);
    assert.deepEqual(writes.slice(-2), ['\x1b[200~recovered\x1b[201~', '\r']);
});
