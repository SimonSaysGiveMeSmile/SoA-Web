const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// The module is browser ESM under web/public; copy it to a .mjs so node 20
// (no syntax detection) loads it as a module too.
async function load() {
    const src = path.join(__dirname, '..', '..', 'web', 'public', 'm', 'tabOrganizer.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taborg-'));
    const dst = path.join(dir, 'tabOrganizer.mjs');
    fs.copyFileSync(src, dst);
    return import(pathToFileURL(dst).href);
}

function memStore() {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test('tab organizer: record round-trips and rejects junk', async () => {
    const o = await load();
    const s = memStore();
    assert.equal(o.loadRecord(s).sort, 'manual');
    s.setItem('soa-web:tab-org:v1', '{nope');
    assert.equal(o.loadRecord(s).sort, 'manual');
    const rec = o.loadRecord(s);
    rec.sort = 'recent';
    o.setArchived(rec, 'b', { id: 3, cwd: '/p', title: 'p' }, true, 1000);
    o.saveRecord(s, rec);
    const back = o.loadRecord(s);
    assert.equal(back.sort, 'recent');
    assert.ok(o.isArchived(back, 'b', 3));
    assert.ok(!o.isArchived(back, 'other', 3));
});

test('tab organizer: sort keeps manual order on ties', async () => {
    const o = await load();
    const act = { 1: 0, 2: 50, 3: 0, 4: 90 };
    assert.deepEqual(o.sortIds([1, 2, 3, 4], 'manual'), [1, 2, 3, 4]);
    assert.deepEqual(o.sortIds([1, 2, 3, 4], 'activity', { activityOf: id => act[id] }), [4, 2, 1, 3]);
    assert.deepEqual(o.sortIds([1, 2, 3, 4], 'recent', { usedOf: id => (id === 3 ? 5 : 0) }), [3, 1, 2, 4]);
});

test('tab organizer: archived entry follows a restarted tab by cwd + title', async () => {
    const o = await load();
    const rec = { v: 1, sort: 'manual', backends: {} };
    o.setArchived(rec, 'b', { id: 7, cwd: '/repo', title: 'api' }, true, 1000);
    o.markUsed(rec, 'b', 7, 2000);
    const tabs = [{ id: 21, cwd: '/repo', title: 'web' }, { id: 22, cwd: '/repo', title: 'api' }];
    assert.equal(o.reconcile(rec, 'b', tabs, 3000), true);
    assert.ok(!o.isArchived(rec, 'b', 7));
    assert.ok(o.isArchived(rec, 'b', 22));
    assert.ok(!o.isArchived(rec, 'b', 21));
    assert.equal(o.lastUsed(rec, 'b', 22), 2000);
});

test('tab organizer: ambiguous cwd is not guessed; stale entries expire', async () => {
    const o = await load();
    const rec = { v: 1, sort: 'manual', backends: {} };
    o.setArchived(rec, 'b', { id: 7, cwd: '/repo', title: 'gone' }, true, 1000);
    const tabs = [{ id: 1, cwd: '/repo', title: 'a' }, { id: 2, cwd: '/repo', title: 'b' }];
    o.reconcile(rec, 'b', tabs, 2000);
    assert.ok(o.isArchived(rec, 'b', 7));
    assert.ok(!o.isArchived(rec, 'b', 1) && !o.isArchived(rec, 'b', 2));
    o.reconcile(rec, 'b', tabs, 1000 + 31 * 24 * 3600 * 1000);
    assert.ok(!o.isArchived(rec, 'b', 7));
});

test('tab organizer: a closed archived tab never hides its sibling on the same repo', async () => {
    const o = await load();
    const rec = { v: 1, sort: 'manual', backends: {} };
    o.setArchived(rec, 'b', { id: 5, cwd: '/repo', title: 'repo' }, true, 1000);
    o.reconcile(rec, 'b', [{ id: 6, cwd: '/repo', title: 'repo-2' }], 2000);
    assert.ok(!o.isArchived(rec, 'b', 6));
    // Two live tabs with the same cwd + title is ambiguous too.
    o.reconcile(rec, 'b', [{ id: 8, cwd: '/repo', title: 'repo' }, { id: 9, cwd: '/repo', title: 'repo' }], 3000);
    assert.ok(!o.isArchived(rec, 'b', 8) && !o.isArchived(rec, 'b', 9));
    assert.ok(o.isArchived(rec, 'b', 5));
});

test('tab organizer: search matches every word across title, cwd and id', async () => {
    const o = await load();
    const t = { id: 12, title: 'api-server', cwd: '/home/dev/api' };
    assert.ok(o.matches('', t));
    assert.ok(o.matches('API dev', t));
    assert.ok(o.matches('#12', t));
    assert.ok(!o.matches('server web', t));
});
