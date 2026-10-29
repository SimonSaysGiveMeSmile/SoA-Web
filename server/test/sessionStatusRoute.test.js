const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-status-route-'));
process.env.SOA_WEB_STATE_DIR = state;
delete process.env.SOA_BUS_DIR;
const metadata = require('../src/sessionModel');
const manager = require('../src/sessionManager');

test('free fleet status carries each session provider and the metadata used by WebSocket snapshots', async t => {
    const previous = metadata.forTab;
    metadata.forTab = tab => ({ agent: tab.agent, model: tab.agent === 'codex' ? 'gpt-6-astra' : 'claude-opus-5-5',
        effort: tab.agent === 'codex' ? 'max' : 'ultracode', modelSource: tab.agent === 'codex' ? 'codex-thread' : 'claude-transcript', modelObservedAt: 12345 });
    const tabs = new Map([[1, { id: 1, cwd: '/same-folder', agent: 'claude' }], [2, { id: 2, cwd: '/same-folder', agent: 'codex' }]]);
    const session = { tabMgr: { order: [1, 2], get: id => tabs.get(id) }, send() {} };
    const app = express();
    app.use(express.json());
    manager.mount(app, (req, res, next) => { req.session = session; next(); }, { sessions: new Map([['test', session]]) });
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        session._manager?.destroy();
        metadata.forTab = previous;
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(state, { recursive: true, force: true });
    });
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/fleet/status');
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.sessions[0].agent, 'claude');
    assert.equal(data.sessions[0].model, 'claude-opus-5-5');
    assert.equal(data.sessions[1].agent, 'codex');
    assert.equal(data.sessions[1].model, 'gpt-6-astra');
    assert.equal(data.sessions[1].effort, 'max');
    assert.equal(data.sessions[1].modelSource, 'codex-thread');
    assert.equal(data.sessions[1].modelObservedAt, 12345);
    assert.equal(session._manager.snapshot().sessions[1].model, data.sessions[1].model);
});
