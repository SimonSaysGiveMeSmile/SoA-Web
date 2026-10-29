const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { install } = require('../src/sessionStatusUpgrade');

test('live upgrade preserves authentication, session selection and activity; rollback restores exact handlers', async t => {
    const app = express();
    const sessions = ['claude', 'codex'].map(agent => ({ tabMgr: { get: id => ({ id, agent }) } }));
    class SessionManager {
        constructor(session) { this.session = session; this.timer = { keep: true }; }
        snapshot() { return { sessions: [{ id: 1, model: 'claude-fable-5', effort: 'ultracode', status: 'working', ctxPct: 23 }],
            counts: { working: 1, codex: 0 }, ts: 123, todos: ['keep'], meetings: ['keep'] }; }
    }
    const managers = sessions.map(session => new SessionManager(session));
    const beforeSnapshot = SessionManager.prototype.snapshot;
    app.get('/api/fleet/status', (req, res, next) => {
        if (req.headers.authorization !== 'test-only') return res.sendStatus(401);
        next();
    }, async (req, res) => {
        const manager = managers[Number(req.query.session) || 0];
        const result = manager.snapshot();
        await new Promise(resolve => setTimeout(resolve, req.query.session === '0' ? 20 : 1));
        res.json({ ok: true, sessions: result.sessions.map(row => ({ id: row.id, model: row.model, effort: row.effort, status: row.status })) });
    });
    const handler = app._router.stack.find(layer => layer.route)?.route.stack.at(-1);
    const beforeHandler = handler.handle;
    let closed = false;
    const metadata = { forTab: tab => ({ agent: tab.agent, model: tab.agent === 'codex' ? 'gpt-6-astra' : 'claude-opus-5-5',
        effort: tab.agent === 'codex' ? 'max' : 'ultracode', modelSource: tab.agent === 'codex' ? 'codex-thread' : 'claude-transcript', modelObservedAt: 456 }),
        close() { closed = true; } };
    const installed = install({ app, SessionManager, metadata });
    assert.equal(install({ app, SessionManager, metadata }), installed, 'installation is idempotent');
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = 'http://127.0.0.1:' + server.address().port + '/api/fleet/status';
    assert.equal((await fetch(base)).status, 401);
    const results = await Promise.all([0, 1].map(async session => {
        const response = await fetch(base + '?session=' + session, { headers: { authorization: 'test-only' } });
        return (await response.json()).sessions[0];
    }));
    assert.deepEqual(results.map(row => row.agent), ['claude', 'codex'], 'overlapping requests with reused numeric IDs stay isolated');
    assert.deepEqual(results.map(row => row.model), ['claude-opus-5-5', 'gpt-6-astra']);
    assert.equal(results[1].effort, 'max');
    assert.equal(results[1].modelSource, 'codex-thread');
    assert.equal(results[1].modelObservedAt, 456);
    assert.equal(results[1].status, 'working');
    const upgraded = managers[1].snapshot();
    assert.equal(upgraded.counts.codex, 1);
    assert.equal(upgraded.counts.working, 1);
    assert.deepEqual(upgraded.todos, ['keep']);
    assert.deepEqual(upgraded.meetings, ['keep']);
    assert.equal(upgraded.sessions[0].ctxPct, 23);
    assert.equal(managers[1].timer.keep, true);
    app._soaSessionStatusRollback();
    assert.equal(SessionManager.prototype.snapshot, beforeSnapshot);
    assert.equal(handler.handle, beforeHandler);
    assert.equal(closed, true);
});
