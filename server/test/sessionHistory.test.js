const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modulePromise = import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.resolve(__dirname, '../../web/public/m/session-history.js'), 'utf8')).toString('base64'));
function storage() {
    const values = new Map();
    return { getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, v) };
}
test('history survives reload, separates clients/backends and never mixes reused tab IDs', async () => {
    const { SessionHistory } = await modulePromise;
    const disk = storage(), a = new SessionHistory(disk);
    const tab = { id: 1, historyId: 'session-one', title: 'Manager' };
    a.update('desktop-a', tab, { messages: [{ from: 'you', full: 'Hello', t: 123 }], draft: 'unsent', terminal: 'last output' });
    const restored = new SessionHistory(disk);
    assert.equal(restored.get('desktop-a', tab).draft, 'unsent');
    assert.equal(restored.get('desktop-a', tab).messages[0].full, 'Hello');
    assert.equal(restored.get('desktop-a', tab).terminal, 'last output');
    assert.equal(restored.get('desktop-b', tab), undefined);
    assert.equal(restored.get('desktop-a', { ...tab, historyId: 'session-two' }), undefined);
    assert.equal(new SessionHistory(storage()).records.length, 0);
    restored.clear();
    assert.equal(new SessionHistory(disk).records.length, 0);
});
test('history is bounded and storage failures cannot crash chat', async () => {
    const { SessionHistory } = await modulePromise;
    const disk = storage(), store = new SessionHistory(disk);
    for (let id = 0; id < 50; id++) store.update('a', { id, historyId: String(id) }, {
        messages: Array.from({ length: 210 }, () => ({ from: 'agent', full: 'x'.repeat(1000) })),
        draft: 'd'.repeat(20000), terminal: 't'.repeat(50000),
    });
    assert.ok(store.records.length <= 40);
    assert.ok(disk.getItem('soa.mobile.history.v1').length <= 1400000);
    assert.equal(store.records[0].draft.length, 16000);
    assert.equal(store.records[0].terminal.length, 24000);
    const broken = new SessionHistory({ getItem() { throw Error('denied'); }, setItem() { throw Error('quota'); } });
    broken.update('a', { id: 1 }, { draft: 'kept in memory' });
    assert.equal(broken.available, false);
    assert.equal(broken.records[0].draft, 'kept in memory');
});
