// The cwd poll must never block the event loop. With dozens of tabs, a
// synchronous lsof per tab every 3s froze every terminal in the app.
const test = require('node:test');
const assert = require('node:assert');
const { TabManager, parseLsofCwds, resolveCwdsByPids } = require('../src/tabManager');

test('parseLsofCwds pairs each pid with the cwd that follows it', () => {
    const out = 'p101\nfcwd\nn/Users/a/proj\np202\nfcwd\nn/tmp/x y\np303\nfcwd\n';
    const m = parseLsofCwds(out);
    assert.strictEqual(m.get(101), '/Users/a/proj');
    assert.strictEqual(m.get(202), '/tmp/x y');
    assert.strictEqual(m.has(303), false);
    assert.strictEqual(parseLsofCwds('').size, 0);
});

test('resolveCwdsByPids is async and finds this process cwd in one call', async () => {
    const p = resolveCwdsByPids([process.pid, 2147483646]);
    assert.ok(p instanceof Promise);
    const m = await p;
    if (process.platform === 'darwin' || process.platform === 'linux') {
        assert.strictEqual(m.get(process.pid), process.cwd());
    }
    assert.strictEqual(m.has(2147483646), false);
});

function fakeManager(pids) {
    const snapshots = [];
    const mgr = new TabManager({ onTabsChange: (l) => snapshots.push(l) });
    let id = 0;
    for (const pid of pids) {
        const tab = {
            id: ++id, exited: false, userRenamed: false, pty: { pid }, cwd: '/nowhere',
            applyCwd(next) { if (!next || next === this.cwd) return false; this.cwd = next; return true; },
        };
        mgr.tabs.set(tab.id, tab);
        mgr.order.push(tab.id);
    }
    mgr._refreshAutoTitles = () => false;
    mgr.list = () => [...mgr.tabs.values()].map(t => ({ id: t.id, cwd: t.cwd }));
    return { mgr, snapshots };
}

test('pokeAllCwds updates every tab and emits one snapshot', async () => {
    const { mgr, snapshots } = fakeManager([process.pid, process.pid]);
    assert.strictEqual(await mgr.pokeAllCwds(), process.platform === 'darwin' || process.platform === 'linux');
    if (process.platform === 'darwin' || process.platform === 'linux') {
        for (const t of mgr.tabs.values()) assert.strictEqual(t.cwd, process.cwd());
        assert.strictEqual(snapshots.length, 1);
        // Nothing moved on the second poll: no snapshot.
        assert.strictEqual(await mgr.pokeAllCwds(), false);
        assert.strictEqual(snapshots.length, 1);
    }
});

test('pokeAllCwds skips a round while the previous one is still running', async () => {
    const { mgr } = fakeManager([process.pid]);
    const first = mgr.pokeAllCwds();
    assert.strictEqual(await mgr.pokeAllCwds(), false);
    await first;
});

test('the poll does not stall the event loop', async () => {
    const { mgr } = fakeManager(Array.from({ length: 40 }, () => process.pid));
    let ticks = 0;
    const iv = setInterval(() => { ticks++; }, 1);
    const started = Date.now();
    await mgr.pokeAllCwds();
    clearInterval(iv);
    const elapsed = Date.now() - started;
    // A blocking poll would let no timer run until it finished.
    if (elapsed > 20) assert.ok(ticks > 0, `event loop starved for ${elapsed}ms`);
});
