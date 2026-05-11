const test = require('node:test');
const assert = require('node:assert/strict');

const auth = require('../src/auth');
const { frame, parse, MSG } = require('../src/protocol');
const { SessionStore } = require('../src/sessionStore');
const { RingBuffer, Tab, TabManager } = require('../src/tabManager');

test('auth: sign/verify round-trip', () => {
    const key = 'x'.repeat(32);
    const signed = auth.sign('hello', key);
    assert.equal(auth.verify(signed, key), 'hello');
});

test('auth: verify rejects tampered mac', () => {
    const key = 'x'.repeat(32);
    const signed = auth.sign('hello', key).replace(/.$/, c => c === 'A' ? 'B' : 'A');
    assert.equal(auth.verify(signed, key), null);
});

test('auth: readCookie parses single + multi-value headers', () => {
    assert.equal(auth.readCookie('a=1; b=2', 'b'), '2');
    assert.equal(auth.readCookie('only=value', 'only'), 'value');
    assert.equal(auth.readCookie('', 'x'), null);
    assert.equal(auth.readCookie(null, 'x'), null);
});

test('protocol: frame/parse round-trip', () => {
    const f = frame(MSG.HELLO, { x: 1 });
    const p = parse(f);
    assert.equal(p.t, 'hello');
    assert.deepEqual(p.d, { x: 1 });
    assert.equal(p.v, 1);
});

test('protocol: parse rejects junk and wrong version', () => {
    assert.equal(parse('not json'), null);
    assert.equal(parse('{"t":"hello","v":99}'), null);
    assert.equal(parse('{"no":"type"}'), null);
});

test('sessions: create + lookup + destroy', () => {
    const store = new SessionStore({ idleTtlMs: 10_000 });
    const s = store.create();
    assert.equal(store.get(s.id), s);
    assert.equal(store.getByToken(s.token), s);
    store.destroy(s);
    assert.equal(store.get(s.id), null);
    store.shutdown();
});

test('sessions: gc evicts stale sessions', () => {
    const store = new SessionStore({ idleTtlMs: 1 });
    const s = store.create();
    s.lastSeen = Date.now() - 1000;
    store.gc();
    assert.equal(store.get(s.id), null);
    store.shutdown();
});

test('ringbuffer: keeps content under cap', () => {
    const rb = new RingBuffer(1024);
    rb.push('hello ');
    rb.push('world');
    assert.equal(rb.snapshot(), 'hello world');
    assert.equal(rb.size, 11);
});

test('ringbuffer: evicts oldest chunks when over cap', () => {
    const rb = new RingBuffer(8);
    rb.push('aaaa');
    rb.push('bbbb');
    rb.push('cccc');
    const snap = rb.snapshot();
    assert.ok(snap.endsWith('cccc'), `expected tail "cccc", got "${snap}"`);
    assert.ok(snap.length <= 8, `expected <= 8 bytes, got ${snap.length}`);
});

test('ringbuffer: trims a single huge chunk down to cap', () => {
    const rb = new RingBuffer(4);
    rb.push('abcdefghij');
    assert.equal(rb.snapshot(), 'ghij');
    assert.equal(rb.size, 4);
});

test('ringbuffer: ignores empty/non-string input', () => {
    const rb = new RingBuffer(16);
    rb.push('');
    rb.push(null);
    rb.push(undefined);
    assert.equal(rb.snapshot(), '');
});

test('tab: scrollback accumulates via pty.onData path', () => {
    // Simulate a Tab without touching node-pty by pushing directly to its
    // scrollback buffer the same way the pty.onData listener would.
    const tab = new Tab({ id: 1, title: 't', scrollbackBytes: 32 });
    tab.scrollback.push('line-1\r\n');
    tab.scrollback.push('line-2\r\n');
    assert.equal(tab.scrollback.snapshot(), 'line-1\r\nline-2\r\n');
});

test('tabManager: scrollback(id) returns tab bytes; unknown id returns empty', () => {
    const mgr = new TabManager();
    const tab = new Tab({ id: 42, title: 't', scrollbackBytes: 64 });
    tab.scrollback.push('hello from 42');
    // Inject without spawning — we only test the lookup surface.
    mgr.tabs.set(42, tab);
    mgr.order.push(42);
    assert.equal(mgr.scrollback(42), 'hello from 42');
    assert.equal(mgr.scrollback(999), '');
});

test('session: activeTab defaults to 0 and accepts updates', () => {
    const store = new SessionStore({ idleTtlMs: 10_000 });
    const s = store.create();
    assert.equal(s.activeTab, 0);
    s.activeTab = 7;
    assert.equal(store.get(s.id).activeTab, 7);
    store.shutdown();
});

// Helper: register a tab on a TabManager without actually spawning a PTY
// (node-pty isn't loaded in this unit harness). Mirrors what `open` does
// sans spawn so disambiguation / auto-title logic can be exercised.
function fakeTab(mgr, { id, cwd, title } = {}) {
    const tab = new Tab({ id, title: title || undefined, cwd, scrollbackBytes: 64 });
    mgr.tabs.set(id, tab);
    mgr.order.push(id);
    if (id >= mgr.next) mgr.next = id + 1;
    return tab;
}

test('tab: default title is cwd basename', () => {
    const tab = new Tab({ id: 1, cwd: '/tmp/projects/Hireal' });
    assert.equal(tab.title, 'Hireal');
    assert.equal(tab.userRenamed, false);
    assert.equal(tab.autoTitleBase, 'Hireal');
});

test('tabManager: auto-titled siblings on same folder get -1, -2', () => {
    const mgr = new TabManager();
    fakeTab(mgr, { id: 1, cwd: '/tmp/projects/Hireal' });
    fakeTab(mgr, { id: 2, cwd: '/tmp/projects/Hireal' });
    mgr._refreshAutoTitles();
    assert.deepEqual(mgr.list().map(t => t.title), ['Hireal-1', 'Hireal-2']);
});

test('tabManager: lone auto-titled tab stays bare; adding a sibling suffixes both', () => {
    const mgr = new TabManager();
    fakeTab(mgr, { id: 1, cwd: '/work/Hireal' });
    mgr._refreshAutoTitles();
    assert.equal(mgr.get(1).title, 'Hireal');
    fakeTab(mgr, { id: 2, cwd: '/work/Hireal' });
    mgr._refreshAutoTitles();
    assert.deepEqual(mgr.list().map(t => t.title), ['Hireal-1', 'Hireal-2']);
});

test('tabManager: user-renamed tab is excluded from auto-title pool', () => {
    const mgr = new TabManager();
    fakeTab(mgr, { id: 1, cwd: '/a/Hireal' });
    fakeTab(mgr, { id: 2, cwd: '/b/Hireal' });
    mgr._refreshAutoTitles();
    // Pin id 1 as "Main"; id 2 is now the only auto "Hireal" left, so it
    // should revert to bare.
    mgr.rename(1, 'Main');
    assert.equal(mgr.get(1).title, 'Main');
    assert.equal(mgr.get(2).title, 'Hireal');
    assert.equal(mgr.get(1).userRenamed, true);
});

test('tabManager: clearing a user rename re-joins the auto-title pool', () => {
    const mgr = new TabManager();
    fakeTab(mgr, { id: 1, cwd: '/a/Hireal' });
    fakeTab(mgr, { id: 2, cwd: '/b/Hireal' });
    mgr._refreshAutoTitles();
    mgr.rename(1, 'Main');
    assert.deepEqual(mgr.list().map(t => t.title), ['Main', 'Hireal']);
    mgr.rename(1, '');
    assert.deepEqual(mgr.list().map(t => t.title), ['Hireal-1', 'Hireal-2']);
    assert.equal(mgr.get(1).userRenamed, false);
});

test('tabManager: cwd change rewrites auto title and re-runs disambiguation', () => {
    const mgr = new TabManager();
    const a = fakeTab(mgr, { id: 1, cwd: '/w/Hireal' });
    const b = fakeTab(mgr, { id: 2, cwd: '/w/Hireal' });
    mgr._refreshAutoTitles();
    assert.deepEqual(mgr.list().map(t => t.title), ['Hireal-1', 'Hireal-2']);
    // Simulate `cd ../other` on tab 2.
    b.cwd = '/w/other';
    b.autoTitleBase = 'other';
    mgr._refreshAutoTitles();
    assert.deepEqual(mgr.list().map(t => t.title), ['Hireal', 'other']);
});
