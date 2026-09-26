const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { mount: mountReplies, repliesFor } = require('../src/tts');
const { mount: mountChat } = require('../src/voiceChat');
const { relay } = require('../../scripts/soa-codex-notify.cjs');

test('completion hook replies survive a disconnected phone and replay only to the owning session and terminal incarnation', async t => {
    const tab = { id: 7, historyId: 'original' }, frames = [];
    const session = { tabMgr: { get: id => id === 7 ? tab : null }, send: f => { frames.push(JSON.parse(f)); return false; } };
    const other = { tabMgr: { get: () => null }, send: () => false };
    const app = express();
    mountReplies(app, { sessions: new Map([['owner', session], ['other', other]]) });
    mountChat(app, (req, res, next) => {
        if (!req.headers.authorization) return res.sendStatus(401);
        req.session = req.headers.authorization === 'owner' ? session : other; next();
    }, () => true);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const env = { SOA_WEB_TAB: '7', SOA_WEB_TTS_URL: base + '/api/tts' };
    await require('node:util').promisify(require('node:child_process').execFile)(process.execPath,
        [require('node:path').resolve(__dirname, '../../scripts/soa-codex-notify.cjs'), '--tab=7', '--url=' + env.SOA_WEB_TTS_URL,
            JSON.stringify({ type: 'agent-turn-complete', 'last-assistant-message': 'The voice reply is ready.' })],
        { env: { ...process.env, SOA_WEB_TAB: '99', SOA_WEB_TTS_URL: 'http://127.0.0.1:1/api/tts' } });
    const get = auth => fetch(base + '/api/voice/chat/replies?id=7', { headers: auth ? { authorization: auth } : {} });
    assert.equal((await get()).status, 401);
    assert.equal((await get('other')).status, 404);
    const response = await get('owner');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { replies } = await response.json();
    assert.equal(replies.length, 1);
    assert.equal(replies[0].text, 'The voice reply is ready.');
    assert.equal(replies[0].id, frames[0].d.id, 'live delivery and recovery share a deduplication ID');
    tab.historyId = 'replacement';
    assert.equal(repliesFor(session, 7).length, 0, 'a reused numeric terminal ID cannot inherit old replies');
    for (let n = 0; n < 105; n++) await relay({ type: 'agent-turn-complete', 'last-assistant-message': 'reply ' + n }, env);
    assert.equal(repliesFor(session, 7).length, 100, 'recovery memory stays bounded');
    assert.equal(repliesFor(session, 7).at(-1).text, 'reply 104');
    other.tabMgr.get = () => ({ id: 7, historyId: 'another-owner' });
    await relay({ type: 'agent-turn-complete', 'last-assistant-message': 'Ambiguous reply must not leak.' }, env);
    assert.equal(repliesFor(other, 7).length, 0);
    assert.equal(repliesFor(session, 7).at(-1).text, 'reply 104');
});
